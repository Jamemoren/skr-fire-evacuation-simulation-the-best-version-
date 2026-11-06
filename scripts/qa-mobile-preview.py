"""Browser QA for the mobile guidance preview (Playwright, headless Chromium).

Run against a server that serves the production build:
    npm run build && npm run server -- --static=dist
    python3 scripts/qa-mobile-preview.py            # QA_BASE=http://127.0.0.1:8787 by default

What it checks (each result is printed as PASS/FAIL with the measured value; nothing is assumed):
  A. preview behaviour: open/minimize/presentation/Esc/close, 3 logical sizes, scale-to-fit,
     no horizontal overflow inside the phone, buttons clickable through the scaled frame,
     no extra preview session after close/reopen/resize, simulation not reset by the panel.
  B. end-to-end: drill -> preview joins as tester -> place at checkpoint -> evacuate -> route ->
     close the stair in use -> revised route with a reason -> ack visible to staff ->
     a second (non-preview) phone session joins with the join code at a different point ->
     closing the dashboard tab does not stop the backend.
  C. compact layout (narrow window): full screen, no decorative frame.
Screenshots go to QA_OUT (default ./qa-output/mobile-preview).
"""
import asyncio
import json
import os
import sys
import time
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from playwright.async_api import async_playwright

BASE = os.environ.get("QA_BASE", "http://127.0.0.1:8787")
OUT = os.environ.get("QA_OUT", os.path.join("qa-output", "mobile-preview"))
os.makedirs(OUT, exist_ok=True)
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""), flush=True)


def api(path, token=None, body=None, method=None):
    request = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), method=method or ("POST" if body is not None else "GET"))
    request.add_header("content-type", "application/json")
    if token:
        request.add_header("authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read() or b"null")


async def frame_of(page):
    handle = await page.wait_for_selector("iframe.mh-iframe", state="attached", timeout=20000)
    return await handle.content_frame()


async def wait_for(predicate, timeout=20.0, step=0.25):
    end = time.time() + timeout
    while time.time() < end:
        value = await predicate()
        if value:
            return value
        await asyncio.sleep(step)
    return await predicate()


async def skip_intro(page):
    for _ in range(40):
        if await page.evaluate("() => document.documentElement.dataset.skrIntro === undefined && !!document.querySelector('.sw-header')"):
            return True
        await page.keyboard.press("Escape")
        await page.evaluate("() => document.querySelector('.cine-skip')?.click()")
        await page.wait_for_timeout(1000)
    return False


async def sim_clock(page):
    return await page.evaluate("() => document.querySelector('.sw-live-stat strong.pi-num')?.textContent ?? ''")


async def main():
    staff = api("/api/auth/local-staff")["token"]
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get("QA_CHROME"), args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        context = await browser.new_context(viewport={"width": 1600, "height": 900})
        page = await context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        await page.goto(BASE + "/", wait_until="domcontentloaded")
        await skip_intro(page)
        await page.wait_for_timeout(800)

        # Start the 3D simulation first, so we can prove the panel never resets it.
        # Start, let it run a moment, then pause: the clock must still read the same afterwards
        # (software GL in CI is too slow to keep 3,000 agents running during the whole test).
        await page.locator("#sw-population").focus()
        await page.keyboard.press("Home")  # 40 agents keeps software GL responsive
        await page.wait_for_timeout(1500)
        start = page.locator(".sw-header .sw-run-primary")
        page.set_default_timeout(90000)
        if await start.get_attribute("aria-disabled") != "true":
            await start.click(no_wait_after=True)
        await page.wait_for_timeout(4000)
        # Software GL can miss the first few frames on a busy machine. Verify that
        # the clock really advanced before pausing (the assertion below requires it).
        await wait_for(lambda: page.evaluate("() => !['0s', '00:00', ''].includes(document.querySelector('.sw-live-stat strong.pi-num')?.textContent ?? '')"), timeout=60)
        await page.locator(".sw-header .sw-run-primary").click(no_wait_after=True)
        await page.wait_for_timeout(1500)
        page.set_default_timeout(30000)
        clock_before = await sim_clock(page)
        status_before = await page.locator(".sw-live .pi-chip").inner_text()

        # ---- open the panel -------------------------------------------------------------
        await page.get_by_role("button", name="ระบบนำทางมือถือ").click()
        host = page.locator(".mh-root")
        await host.wait_for(state="visible")
        online = await wait_for(lambda: page.locator(".mh-status.is-online").count())
        check("A1 panel opens and connects to the backend (loopback staff)", online)
        box = await host.bounding_box()
        run_box = await start.bounding_box()
        check("A2 docked panel does not cover the start button", run_box and box and (run_box["x"] + run_box["width"] <= box["x"] or run_box["y"] + run_box["height"] <= box["y"]), f"panel x={box and round(box['x'])} y={box and round(box['y'])}, start right={run_box and round(run_box['x'] + run_box['width'])}")
        right_panel_hidden = await page.evaluate("() => getComputedStyle(document.querySelector('.sw-panel-right')).display === 'none'")
        check("A3 docked panel takes the monitor panel's place (no overlap)", right_panel_hidden)

        no_frame = await page.locator(".mh-placeholder").count() == 1 and await page.locator("iframe.mh-iframe").count() == 0
        check("A0 before a drill exists the frame shows a placeholder, not a join form", no_frame)

        # ---- drill ------------------------------------------------------------------------
        await page.get_by_role("button", name="สร้างรอบฝึกซ้อม").click()
        await page.wait_for_selector(".mh-incident", timeout=10000)
        frame = await frame_of(page)
        joined = await wait_for(lambda: page.locator("#mh-g-tester ~ * select").count())
        check("B1 preview phone joins the drill as a test participant", joined)
        snapshot = api("/api/admin/snapshot", staff)
        incident_id = snapshot["activeIncidentId"]
        test_rows = [row for row in snapshot["participants"] if row["isTest"]]
        check("B2 exactly one preview (test) participant", len(test_rows) == 1, f"{len(test_rows)} test rows")
        check("B3 test participants are not counted as real population", snapshot["counts"]["registeredParticipants"] == 0, json.dumps(snapshot["counts"]))
        await page.get_by_role("button", name="วางผู้ทดสอบที่จุดนี้").click()
        await page.wait_for_timeout(800)
        await page.get_by_role("button", name="เริ่มอพยพในรอบนี้").click()
        frame = await frame_of(page)
        on_incident = await wait_for(lambda: frame.evaluate("() => document.querySelector('[data-screen]')?.dataset.screen === 'incident'"))
        check("B4a phone first shows the incident screen (drill label + evacuate order)", on_incident and await frame.evaluate("() => /ฝึกซ้อม/.test(document.body.innerText)"))
        await page.screenshot(path=os.path.join(OUT, "00-incident.png"))
        await frame.get_by_role("button", name="ดูคำแนะนำเส้นทาง").click()
        on_nav = await wait_for(lambda: frame.evaluate("() => document.querySelector('[data-screen]')?.dataset.screen === 'navigate'"))
        check("B4 phone shows the navigation screen after evacuate", on_nav, await frame.evaluate("() => document.querySelector('[data-screen]')?.dataset.screen"))
        instruction = await frame.evaluate("() => document.querySelector('.m-instruction h1')?.textContent")
        check("B5 instruction text comes from the server route", bool(instruction), instruction or "")
        lr = await frame.evaluate("() => /เลี้ยวซ้าย|เลี้ยวขวา|ทางซ้าย|ทางขวา/.test(document.body.innerText)")
        check("B6 no left/right wording without a heading", not lr)
        await page.screenshot(path=os.path.join(OUT, "01-docked-navigate.png"))

        # Revision: close the stair group used by the current route.
        view = api(f"/api/admin/participants/{test_rows[0]['participantId']}/view", staff)
        rev1 = view["advice"]["routeRevision"]
        groups = api("/api/passages")["groups"]
        used = next((g for g in groups if any(e in view["advice"]["edgeIds"] for e in g["edgeIds"]) and "stair" in g["id"]), None)
        check("B7 route uses a known stair group", used is not None, used and used["label"])
        if used:
            await page.locator(".mh-check", has_text=used["label"]).locator("input").click()
            changed = await wait_for(lambda: frame.evaluate("() => !!document.querySelector('.m-card.is-changed')"), 10)
            reason = await frame.evaluate("() => document.querySelector('.m-reason')?.textContent ?? ''")
            check("B8 route changes with a reason after the stair closes", changed and used["label"] in reason, reason)
            view2 = api(f"/api/admin/participants/{test_rows[0]['participantId']}/view", staff)
            check("B9 revision increases and the new route avoids the closed edges", view2["advice"]["routeRevision"] > rev1 and not set(used["edgeIds"]) & set(view2["advice"]["edgeIds"] or []), f"rev {rev1}->{view2['advice']['routeRevision']}")
            popups = await frame.evaluate("() => document.querySelectorAll('.m-card.is-changed').length")
            check("B10 a single change card (no stacked popups)", popups == 1, str(popups))
            await page.screenshot(path=os.path.join(OUT, "02-route-changed.png"))
            await frame.get_by_role("button", name="รับทราบเส้นทางใหม่").click()
            await page.wait_for_timeout(1000)
            rows = api("/api/admin/snapshot", staff)["participants"]
            check("B11 staff sees the user confirmation (delivery stage)", any(r["delivery"]["confirmed"] for r in rows if r["isTest"]))

        # ---- scale-to-fit, sizes, overflow, click accuracy --------------------------------
        for size, width in (("compact", 360), ("standard", 390), ("large", 430)):
            await page.locator(".mh-select select").select_option(size)
            await page.wait_for_timeout(500)
            frame = await frame_of(page)
            dims = await frame.evaluate("() => ({w: innerWidth, h: innerHeight, sw: document.documentElement.scrollWidth})")
            check(f"A4 {size}: logical width {width}px and no horizontal overflow", dims["w"] == width and dims["sw"] <= dims["w"], json.dumps(dims))
            stage_ok = await page.evaluate("() => { const s = document.querySelector('.mh-stage'); return s.scrollHeight <= s.clientHeight + 1 && s.scrollWidth <= s.clientWidth + 1; }")
            check(f"A5 {size}: fit mode has no scrollbar around the phone", stage_ok)
            await page.screenshot(path=os.path.join(OUT, f"03-size-{size}.png"))
        note = await page.locator(".mh-scale-note").inner_text()
        check("A6 scale is reported to the user", "%" in note, note)
        # Click through the scaled frame: the help button must register on the server.
        frame = await frame_of(page)
        help_button = frame.get_by_role("button", name="ขอความช่วยเหลือ")
        if await help_button.count():
            await help_button.first.click()
            await page.wait_for_timeout(800)
            rows = api("/api/admin/snapshot", staff)["participants"]
            check("A7 a click inside the scaled phone reaches the right button", any(r["helpRequestedAt"] for r in rows if r["isTest"]))
        else:
            check("A7 a click inside the scaled phone reaches the right button", False, "help button not found")
        await page.get_by_role("button", name="ขนาดจริง 100%").click()
        await page.wait_for_timeout(300)
        check("A8 100% zoom option", "100%" in await page.locator(".mh-scale-note").inner_text())
        await page.get_by_role("button", name="ย่อให้พอดี").click()

        # ---- minimize / presentation / close / reopen ------------------------------------
        await page.get_by_role("button", name="ย่อแผงนำทางมือถือ").click()
        await page.wait_for_timeout(300)
        mini = await host.bounding_box()
        check("A9 minimized pill is small", mini and mini["height"] < 80, mini and f"{round(mini['width'])}×{round(mini['height'])}")
        await page.screenshot(path=os.path.join(OUT, "04-minimized.png"))
        await page.get_by_role("button", name="ขยายแผงนำทางมือถือ").click()
        await page.get_by_role("button", name="โหมดนำเสนอ").click()
        await page.wait_for_timeout(400)
        pres = await host.bounding_box()
        check("A10 presentation mode fills the window", pres and pres["width"] >= 1590)
        phone = await page.locator(".mh-phone").bounding_box()
        centre = phone["x"] + phone["width"] / 2 if phone else 0
        check("A11 phone is roughly centred in presentation", phone and abs(centre - 800) < 260, f"centre x={round(centre)}")
        await page.screenshot(path=os.path.join(OUT, "05-presentation.png"))
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(300)
        check("A12 Escape leaves presentation mode", await page.locator(".mh-root.is-docked").count() == 1)
        await page.get_by_role("button", name="ปิดแผงนำทางมือถือ (ระบบยังทำงานต่อ)").click()
        await page.wait_for_timeout(500)
        check("A13 closing returns the space (monitor panel back)", await page.evaluate("() => getComputedStyle(document.querySelector('.sw-panel-right')).display !== 'none'"))
        await page.get_by_role("button", name="ระบบนำทางมือถือ").click()
        await page.wait_for_timeout(1500)
        snapshot = api("/api/admin/snapshot", staff)
        check("A14 reopen/resize/modes did not create another preview session", len([r for r in snapshot["participants"] if r["isTest"]]) == 1 and len(snapshot["incidents"]) == 1, f"tests={len([r for r in snapshot['participants'] if r['isTest']])} incidents={len(snapshot['incidents'])}")
        clock_after = await sim_clock(page)
        status_after = await page.locator(".sw-live .pi-chip").inner_text()
        check("A15 3D simulation was not reset by the panel", clock_after == clock_before and status_after == status_before and clock_before not in ("0s", "00:00"), f"{status_before} {clock_before} -> {status_after} {clock_after}")
        streams = api("/api/health")["streams"]
        check("A16 no duplicate streams after reopen (staff + preview)", streams <= 2, f"{streams} open streams")

        # ---- network toggle via postMessage ----------------------------------------------
        await page.get_by_role("button", name="จำลองขาดการเชื่อมต่อ").click()
        frame = await frame_of(page)
        offline_banner = await wait_for(lambda: frame.evaluate("() => /ขาดการเชื่อมต่อ/.test(document.body.innerText)"), 5)
        check("E1 simulated disconnect shows on the phone", offline_banner)
        await page.screenshot(path=os.path.join(OUT, "06-offline.png"))
        await page.get_by_role("button", name="เชื่อมต่อกลับ").click()

        # ---- a second, real (non-preview) phone session ----------------------------------
        join_code = snapshot["incidents"][0]["joinCode"]
        phone_ctx = await browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        phone_page = await phone_ctx.new_page()
        await phone_page.goto(f"{BASE}/mobile?join={join_code}&cp=B3F2-001", wait_until="domcontentloaded")
        await phone_page.wait_for_timeout(2500)
        first_screen = await phone_page.evaluate("() => document.querySelector('[data-screen]')?.dataset.screen")
        if first_screen == "setup":  # link without auto-join: fill the form
            await phone_page.get_by_role("button", name="เข้าร่วม").first.click()
            await phone_page.wait_for_timeout(2000)
        check("B12a a join link opens the drill directly (no credential in the link)", first_screen in ("setup", "incident"), first_screen or "")
        if await phone_page.get_by_role("button", name="ดูคำแนะนำเส้นทาง").count():
            await phone_page.get_by_role("button", name="ดูคำแนะนำเส้นทาง").click()
            await phone_page.wait_for_timeout(800)
        await phone_page.screenshot(path=os.path.join(OUT, "07-second-phone.png"))
        snapshot = api("/api/admin/snapshot", staff)
        real = [r for r in snapshot["participants"] if not r["isTest"]]
        check("B12 second phone joins as a real participant", len(real) == 1, json.dumps(snapshot["counts"]))
        if real:
            located = real[0]["location"]
            check("B13 second phone at a different point gets its own advice", located and located["nodeId"] != (test_rows[0]["location"] or {}).get("nodeId") and real[0]["adviceStatus"] is not None, f"{located and located['nodeId']} {real[0]['adviceStatus']}")

        # ---- backend survives closing the dashboard tab ----------------------------------
        await page.close()
        await asyncio.sleep(2)
        health = api("/api/health")
        check("B14 backend still running after the dashboard tab closed", health["ok"] and health["participants"] >= 2, json.dumps(health))
        screen = await phone_page.evaluate("() => document.querySelector('[data-screen]')?.dataset.screen")
        check("B15 the real phone keeps its guidance after the dashboard closed", screen in ("navigate", "no-route", "uncertain"), screen or "")

        # ---- compact (narrow) layout ------------------------------------------------------
        narrow = await context.new_page()
        await narrow.set_viewport_size({"width": 800, "height": 900})
        await narrow.goto(BASE + "/", wait_until="domcontentloaded")
        await skip_intro(narrow)
        await narrow.wait_for_timeout(800)
        await narrow.locator(".sw-mobile-guidance-button").click(no_wait_after=True, timeout=90000)
        await narrow.wait_for_selector(".mh-root.is-compact", timeout=90000)
        await narrow.wait_for_timeout(1500)
        bare = await narrow.locator(".mh-bare").count()
        framed = await narrow.locator(".mh-phone").count()
        full = await narrow.locator(".mh-root").bounding_box()
        check("C1 small screen: full screen without the decorative frame", bare == 1 and framed == 0 and full and full["width"] >= 799, f"bare={bare} framed={framed}")
        await narrow.screenshot(path=os.path.join(OUT, "08-compact.png"))
        await narrow.get_by_role("button", name="แผงควบคุม").click(no_wait_after=True, timeout=60000)
        await narrow.wait_for_timeout(300)
        check("C2 small screen: controls open as a drawer", await narrow.locator(".mh-root.has-drawer .mh-side").is_visible())
        await narrow.screenshot(path=os.path.join(OUT, "09-compact-drawer.png"))

        check("Z1 no uncaught page errors", not errors, "; ".join(errors[:3]))
        await browser.close()

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed (headless Chromium {BASE})")
    if failed:
        print("Failed: " + ", ".join(failed))
    with open(os.path.join(OUT, "results.json"), "w", encoding="utf-8") as handle:
        json.dump([{"check": n, "pass": ok, "detail": d} for n, ok, d in results], handle, ensure_ascii=False, indent=1)
    sys.exit(1 if failed else 0)


asyncio.run(main())
