"""Browser QA for the Roleplay Evacuation Simulator (run against Vite dev = StrictMode, and against
a production build). Needs the guidance backend and the page:

  node scripts/evac-server.mjs --port=8799
  EVAC_API_URL=http://127.0.0.1:8799 npx vite --port 5199          (dev)
  EVAC_API_URL=http://127.0.0.1:8799 npx vite preview --port 5199  (production build)
  QA_BASE=http://127.0.0.1:5199 QA_API=http://127.0.0.1:8799 python3 scripts/qa-roleplay-browser.py [--quick]

Steering uses only what a person has: the keyboard (W/A/S/D through the real key listeners) and the
view direction (the yaw the mouse would change). The direction to turn comes from the player's
phone arrow, so reaching the assembly area also tests that the arrow points the right way.

Time: the headless software renderer draws under 1 frame per second here, so after one real-time
check (C0) the test advances the world with __skrRoleplay.tick(s): the same runtime.advance and the
same per-frame player step the render loop calls, in 1/60 s steps. Network calls (phone, adapter)
stay real and asynchronous.
"""
import asyncio, json, math, os, sys, time, urllib.request
from playwright.async_api import async_playwright

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

BASE = os.environ.get('QA_BASE', 'http://127.0.0.1:5199')
API = os.environ.get('QA_API', 'http://127.0.0.1:8799')
CHROME = os.environ.get('QA_CHROME')
SHOTS = os.environ.get('QA_SHOTS', '/tmp/rpshots')
QUICK = '--quick' in sys.argv
results = []

def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS' if ok else 'FAIL') + '  ' + name + (('  — ' + str(detail)) if detail != '' else ''), flush=True)

def api(path, token=None, body=None):
    req = urllib.request.Request(API + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={'content-type': 'application/json', **({'authorization': 'Bearer ' + token} if token else {})})
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.loads(response.read())

R = 'window.__skrRoleplay'

async def state(page, expr):
    return await page.evaluate(f'(() => {{ const R = {R}; const S = R.store.getState(); return {expr}; }})()')

async def position(page):
    return await page.evaluate(f'{R}.session.navigator ? [...{R}.session.navigator.position] : null')

def hdist(a, b):
    return math.hypot(a[0] - b[0], a[2] - b[2])

async def snapshot_for(staff, incident_id):
    """Counts of one incident (the roleplay incident is not the control centre's active one)."""
    before = api('/api/admin/snapshot', staff)['activeIncidentId']
    api(f'/api/admin/incidents/{incident_id}/active', staff, {})
    snap = api('/api/admin/snapshot', staff)
    if before: api(f'/api/admin/incidents/{before}/active', staff, {})
    return snap

async def open_setup(page):
    await page.click('.sw-roleplay-button')
    await page.wait_for_selector('.rp-setup')

async def wait_check(page):
    await page.wait_for_function(f'{R}.store.getState().prepared && !{R}.store.getState().preparing', timeout=60000)
    await page.wait_for_selector('.rp-ok, .rp-bad', timeout=30000)

async def choose(page, building, floor, option_index=0, npc=None, fire=None, behavior=None, closures=()):
    selects = page.locator('.rp-setup select')
    await selects.nth(0).select_option(building)
    await page.wait_for_timeout(100)
    await selects.nth(1).select_option(str(floor))
    await page.wait_for_timeout(100)
    values = await selects.nth(2).locator('option').evaluate_all('(os) => os.map((o) => o.value)')
    await selects.nth(2).select_option(values[min(option_index, len(values) - 1)])
    if npc is not None: await selects.nth(3).select_option(str(npc))
    if behavior is not None: await selects.nth(4).select_option(behavior)
    if fire is not None: await selects.nth(5).select_option(fire)
    # The setup keeps the last scenario (replaying it is a feature): set closures explicitly.
    boxes = page.locator('.rp-closures input[type=checkbox]')
    for index in range(await boxes.count()):
        if await boxes.nth(index).is_checked(): await boxes.nth(index).uncheck()
    for label in closures:
        await page.locator('.rp-closures label', has_text=label).locator('input').check()
    await page.wait_for_timeout(400)
    await wait_check(page)
    return values

async def start(page):
    await page.click('.rp-setup .rp-btn.is-primary')
    await page.wait_for_function(f'{R}.store.getState().phase === "playing"', timeout=60000)

async def steer_step(page):
    """Turn the view toward the phone's arrow and hold W (the arrow is relative to the view)."""
    await page.evaluate(f'''(() => {{
      const R = {R}; const g = R.store.getState().guide;
      if (g && g.bearingDeg !== null) R.session.yaw -= g.bearingDeg * Math.PI / 180 * 0.7;
      R.keys.add("KeyW");
    }})()''')

async def release(page):
    await page.evaluate(f'{R}.keys.clear()')

async def tick(page, seconds):
    await page.evaluate(f'{R}.tick({seconds})')

async def walk_following(page, seconds, until=None):
    """Follow the arrow for `seconds` of simulated time; stops early when until() is true."""
    elapsed = 0.0
    while elapsed < seconds:
        await steer_step(page)
        await tick(page, 0.25)
        elapsed += 0.25
        await page.wait_for_timeout(25)  # let phone/adapter network replies arrive
        if until and await until(): break
    await release(page)

async def main():
    os.makedirs(SHOTS, exist_ok=True)
    staff = api('/api/auth/local-staff')['token']
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        page = await browser.new_page(viewport={'width': 1600, 'height': 900})
        page.set_default_timeout(90000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: errors.append('console: ' + message.text) if message.type == 'error' and 'favicon' not in message.text else None)
        await page.goto(BASE + '/?intro=0&qa=1', wait_until='domcontentloaded')
        await page.wait_for_selector('.sw-roleplay-button')
        await page.wait_for_timeout(3000)
        active_before = api('/api/admin/snapshot', staff)['activeIncidentId']

        # ------------------------------------------------------------ setup + spawn validation
        await open_setup(page)
        check('S1 the "สวมบทอพยพ" button opens the setup', await page.locator('.rp-setup').is_visible())
        check('S2 the dashboard is hidden while the roleplay runs (one UI owns the screen)', await page.locator('.sw-root').evaluate('(el) => getComputedStyle(el).display') == 'none')
        await choose(page, 'building-1', 5, 0, npc=20)
        check('S3 B1 floor 5 classroom is a valid spawn and Start is enabled', await page.locator('.rp-ok').count() == 1 and await page.locator('.rp-setup .rp-btn.is-primary').is_enabled())
        marker = await state(page, 'S.plan && S.plan.requested.point')
        check('S4 marker preview at the planned point (same floor height)', marker is not None and abs(marker[1] - 14.2) < 0.6, marker)
        await page.screenshot(path=f'{SHOTS}/01-setup-valid.png')

        # Invalid spawn: fire on the centre stair of floor 4, then look for a point it rules out.
        await page.locator('.rp-setup select').nth(5).select_option('center')
        found_invalid = None
        values = await choose(page, 'building-1', 4, 0, fire='center')
        for index in range(len(values)):
            await page.locator('.rp-setup select').nth(2).select_option(values[index])
            await page.wait_for_timeout(350)
            await wait_check(page)
            if await page.locator('.rp-bad').count():
                found_invalid = values[index]; break
        check('S5 a spawn in/near fire is refused with reasons', found_invalid is not None, found_invalid)
        if found_invalid:
            reasons = await page.locator('.rp-bad li').all_inner_texts()
            check('S6 reasons are given in Thai', len(reasons) > 0, reasons[:2])
            check('S7 Start stays disabled until the user accepts the suggestion', not await page.locator('.rp-setup .rp-btn.is-primary').is_enabled())
            plan = await state(page, 'S.plan')
            suggestion = plan.get('suggestion') if plan else None
            check('S8 the suggestion is on the same building and floor (never silently another floor)', suggestion is not None and suggestion['choice']['floor'] == 4 and suggestion['choice']['buildingId'] == 'building-1', suggestion and suggestion['choice'])
            await page.screenshot(path=f'{SHOTS}/02-setup-invalid.png')
            if suggestion:
                await page.locator('.rp-bad input[type=checkbox]').check()
                check('S9 accepting the shown suggestion enables Start', await page.locator('.rp-setup .rp-btn.is-primary').is_enabled())
        # Lift bank / void are covered by scripts/qa-roleplay.mjs (D); back to a clean scenario.
        await page.locator('.rp-setup select').nth(5).select_option('none')
        await choose(page, 'building-1', 5, 0, npc=20)

        # ------------------------------------------------------------ start: one incident, one player, one stream
        await start(page)
        incident_id = await state(page, 'S.incidentId')
        check('P1 run started with its own simulation incident', bool(incident_id), incident_id)
        check('P2 the control centre\'s active incident is unchanged', api('/api/admin/snapshot', staff)['activeIncidentId'] == active_before)
        await page.wait_for_selector('.rp-phone [data-screen="navigate"]', timeout=30000)
        check('P3 the player\'s phone shows navigation (SIMULATOR badge, arrow card)', await page.locator('.rp-phone .m-badge.is-player').count() == 1 and await page.locator('.rp-phone .m-card.is-player-arrow').count() == 1)
        await page.wait_for_timeout(1500)
        snap = await snapshot_for(staff, incident_id)
        players = [row for row in snap['participants'] if row.get('isPlayer')]
        check('P4 exactly one player participant and one open stream (StrictMode safe)', len(players) == 1 and snap['counts']['openStreams'] == 1 and snap['counts']['sessions'] == 1, snap['counts'])
        check('P5 the player is a test participant (never counted as a real person)', players and players[0]['isTest'] is True)
        sim_speed = await page.evaluate(f'{R}.sim.getState().speedFactor')
        check('P6 the run starts at 1× speed', sim_speed == 1, sim_speed)
        await page.screenshot(path=f'{SHOTS}/03-playing.png')

        # ------------------------------------------------------------ controls
        r0 = await position(page); frames0 = await page.evaluate(f'{R}.session.perf.frames')
        await page.keyboard.down('w'); await page.wait_for_timeout(4000); await page.keyboard.up('w')
        r1 = await position(page); frames1 = await page.evaluate(f'{R}.session.perf.frames')
        check('C0 real time: holding W moves the character through the render loop', hdist(r0, r1) > 0.005 and frames1 > frames0, f'{hdist(r0, r1):.3f} m in {frames1 - frames0} rendered frames (software renderer)')
        await tick(page, 0.5)
        p0 = await position(page)
        await page.keyboard.down('w'); await tick(page, 1.0); await page.keyboard.up('w')
        await tick(page, 0.6)
        p1 = await position(page)
        forward = hdist(p0, p1)
        check('C1 W moves the character about walking speed (1.35 m/s)', 0.9 < forward < 1.6, round(forward, 2))
        await page.keyboard.down('w'); await page.keyboard.down('d'); await tick(page, 1.0)
        await page.keyboard.up('d'); await page.keyboard.up('w'); await tick(page, 0.6)
        p2 = await position(page)
        diagonal = hdist(p1, p2)
        check('C2 diagonal W+D is not faster than W alone (normalised)', diagonal <= forward * 1.1 + 0.05, f'W {forward:.2f} m, W+D {diagonal:.2f} m')
        await page.keyboard.down('w'); await tick(page, 0.2)
        await page.evaluate('window.dispatchEvent(new Event("blur"))')
        b0 = await position(page); await tick(page, 0.6); b1 = await position(page)
        await page.keyboard.up('w')
        check('C3 keys are released on window blur', hdist(b0, b1) < 0.05, round(hdist(b0, b1), 3))
        await page.evaluate('(() => { const i = document.createElement("input"); i.id = "qa-type"; document.body.appendChild(i); i.focus(); })()')
        t0 = await position(page); await page.keyboard.down('w'); await tick(page, 0.6); await page.keyboard.up('w'); t1 = await position(page)
        await page.evaluate('document.getElementById("qa-type").remove()')
        check('C4 typing in a field never moves the character', hdist(t0, t1) < 0.02, round(hdist(t0, t1), 3))
        pointer = await state(page, 'S.pointer')
        check('C5 pointer lock state is reported (locked/free/unsupported fallback)', pointer in ('locked', 'free', 'unsupported'), pointer)

        # Arrow relative to the view, four directions.
        await page.wait_for_function(f'{R}.store.getState().guide && {R}.store.getState().guide.bearingDeg !== null', timeout=20000)
        bearings = []
        for turn in range(4):
            await page.evaluate(f'{R}.session.yaw += Math.PI / 2')
            await tick(page, 0.2)
            bearings.append(await state(page, 'S.guide.bearingDeg'))
        steps = [((bearings[(i + 1) % 4] - bearings[i] + 540) % 360) - 180 for i in range(4)]
        check('C6 turning the view 90° left moves the arrow 90° right, in all four directions', all(abs(step - 90) < 12 for step in steps), [round(b) for b in bearings])

        # ------------------------------------------------------------ phone follows the character
        first_node = await state(page, 'S.guide.place.nodeId')
        await walk_following(page, 15)
        later_node = await state(page, 'S.guide.place.nodeId')
        snap = await snapshot_for(staff, incident_id)
        row = next(row for row in snap['participants'] if row.get('isPlayer'))
        check('F1 walking changes the character\'s graph node', first_node != later_node, f'{first_node} → {later_node}')
        location = row.get('location') or {}
        check('F2 the server has the character\'s own position (source simulator, position + heading)', location.get('source') == 'simulator' and location.get('position') is not None and location.get('headingDeg') is not None, {k: location.get(k) for k in ('source', 'nodeId', 'floor', 'buildingId')})
        rtt = await state(page, 'S.perf.poseRttMs')
        check('F3 position report round trip is measured', isinstance(rtt, (int, float)), rtt)

        # ------------------------------------------------------------ reroute on a closure during the walk
        before = await state(page, 'S.hud.reroutes')
        await page.keyboard.press('Escape')
        await page.wait_for_selector('#rp-menu-title')
        sim_status = await page.evaluate(f'{R}.sim.getState().status')
        check('M1 Esc opens the menu and pauses the shared clock', sim_status == 'paused', sim_status)
        await page.screenshot(path=f'{SHOTS}/04-menu.png')
        await page.get_by_role('button', name='ทดสอบ: ปิดบันได/ทางออกบนเส้นทางข้างหน้า').click()
        note = await page.locator('.rp-note').inner_text()
        await page.get_by_role('button', name='เล่นต่อ', exact=True).click()
        async def rerouted_now():
            return await state(page, f'S.hud.reroutes > {before}')
        await walk_following(page, 6, until=rerouted_now)
        rerouted = await rerouted_now()
        check('R1 closing the passage ahead re-routes the player\'s phone', rerouted, note)
        if rerouted:
            await page.wait_for_selector('.rp-phone .m-card.is-changed', timeout=5000)
            reason = await page.locator('.rp-phone .m-card.is-changed .m-reason').inner_text()
            check('R2 the phone shows why the route changed', 'ปิด' in reason, reason)
            await page.screenshot(path=f'{SHOTS}/05-rerouted.png')

        # ------------------------------------------------------------ disconnect is shown as not live
        await page.locator('.rp-phone .rp-switch input').uncheck()
        try:
            await page.wait_for_selector('.rp-phone [data-screen="offline"]', timeout=8000); offline = True
        except Exception:
            offline = False
        check('N1 a cut network shows "not live" on the phone', offline)
        await page.screenshot(path=f'{SHOTS}/06-offline.png')
        await page.locator('.rp-phone .rp-switch input').check()
        try:
            await page.wait_for_selector('.rp-phone [data-screen="navigate"]', timeout=15000); back = True
        except Exception:
            back = False
        check('N2 reconnecting brings live guidance back', back)

        # ------------------------------------------------------------ walk to the assembly area
        async def done():
            return await state(page, 'S.phase') == 'result'
        await walk_following(page, 600, until=done)
        phase = await state(page, 'S.phase')
        result = await state(page, 'S.result')
        check('A1 the character reaches an assembly area by walking', phase == 'result' and result and result['outcome'] == 'arrived', (result and {k: result[k] for k in ('outcome', 'assemblyName', 'seconds', 'distance')}) or await page.evaluate(f'''(() => {{ const R = {R}; const S = R.store.getState(); const n = R.session.navigator;
          return {{ phase: S.phase, pos: n && n.position.map((v) => +v.toFixed(2)), support: n && n.support.id, place: S.guide && S.guide.place.nodeId, bearing: S.guide && S.guide.bearingDeg, off: S.guide && S.guide.offRouteM,
            route: R.session.route && R.session.route.nodeIds.slice(0, 4), screen: document.querySelector('.rp-phone [data-screen]')?.dataset.screen,
            near: n ? R.runtime.agents.filter((a) => a.status !== 'arrived' && Math.hypot(a.position[0] - n.position[0], a.position[2] - n.position[2]) < 1.2 && Math.abs(a.position[1] - n.position[1]) < 1.2).length : 0 }}; }})()'''))
        if result:
            check('A2 results: time, distance, reroutes, crowding, exposure, assembly', result['seconds'] > 0 and result['distance'] > 10 and result['assemblyName'], {k: (round(v, 1) if isinstance(v, float) else v) for k, v in result.items() if k != 'reroutes'})
        await page.screenshot(path=f'{SHOTS}/07-result.png')
        await page.wait_for_timeout(1500)
        snap = await snapshot_for(staff, incident_id)
        inc = next(item for item in snap['incidents'] if item['id'] == incident_id)
        check('A3 the run\'s incident is ended and its stream closed', inc['phase'] == 'ended' and snap['counts']['openStreams'] == 0, (inc['phase'], snap['counts']['openStreams']))

        # ------------------------------------------------------------ B3 spawn, no-route, exit cleanup
        await page.get_by_role('button', name='เล่นอีกครั้ง').click()
        await page.wait_for_selector('.rp-setup')
        await choose(page, 'building-3', 3, 0, npc=20)
        await start(page)
        await page.wait_for_selector('.rp-phone [data-screen="navigate"]', timeout=30000)
        b3_incident = await state(page, 'S.incidentId')
        await walk_following(page, 10)
        place = await state(page, 'S.guide.place')
        check('B1 a Building 3 spawn walks with its own phone guidance', place['buildingId'] in ('building-3', 'building-4', 'site'), place)

        # Fire ahead during the walk (own run, so it never mixes with the closure test).
        before = await state(page, 'S.hud.reroutes')
        await page.keyboard.press('Escape'); await page.wait_for_selector('#rp-menu-title')
        await page.get_by_role('button', name='ทดสอบ: เพิ่มไฟบนเส้นทางข้างหน้า').click()
        fire_note = await page.locator('.rp-note').inner_text()
        await page.get_by_role('button', name='เล่นต่อ', exact=True).click()
        async def fire_seen():
            screen = await page.locator('.rp-phone [data-screen]').get_attribute('data-screen')
            return screen == 'no-route' or await page.locator('.rp-phone .m-hazards li').count() > 0 or await state(page, f'S.hud.reroutes > {before}')
        await walk_following(page, 60, until=fire_seen)
        seen = await fire_seen()
        hazards = await page.locator('.rp-phone .m-hazards li').all_inner_texts()
        check('R3 a fire placed on the route reaches the player\'s phone (hazard listed, route changed, or no route)', seen, {'note': fire_note, 'hazards': hazards[:2], 'reroutes': await state(page, 'S.hud.reroutes')})
        world = await state(page, 'S.perf.worldSends')
        check('R4 the simulator adapter sent world snapshots (fire/smoke/crowd ground truth)', world > 0, world)
        await page.screenshot(path=f'{SHOTS}/08-fire-ahead.png')
        await page.keyboard.press('Escape'); await page.wait_for_selector('#rp-menu-title')
        await page.get_by_role('button', name='ออกจากโหมดสวมบท').click()
        await page.wait_for_function(f'{R}.store.getState().phase === "off"')
        await page.wait_for_timeout(1500)
        left = await page.evaluate(f'({{ nav: {R}.session.navigator, body: {R}.runtime.playerBody, keys: {R}.keys.size, lock: !!document.pointerLockElement, rp: !!document.querySelector(".rp-root") }})')
        check('X1 exit leaves no controller state, body, keys, pointer lock or UI', left == {'nav': None, 'body': None, 'keys': 0, 'lock': False, 'rp': False}, left)
        snap = await snapshot_for(staff, b3_incident)
        inc = next(item for item in snap['incidents'] if item['id'] == b3_incident)
        check('X2 exit ends the incident and closes the phone stream', inc['phase'] == 'ended' and snap['counts']['openStreams'] == 0, (inc['phase'], snap['counts']['openStreams']))
        check('X3 the dashboard is back', await page.locator('.sw-root').evaluate('(el) => getComputedStyle(el).display') != 'none')

        if not QUICK:
            # No exit: every Building 1 stair closed from floor 5 → the phone says so, no arrow is forced.
            await open_setup(page)
            await choose(page, 'building-1', 5, 0, npc=20, closures=('บันไดซ้าย อาคาร 1', 'บันไดกลาง อาคาร 1', 'บันไดขวา อาคาร 1'))
            await start(page)
            try:
                await page.wait_for_selector('.rp-phone [data-screen="no-route"]', timeout=30000); no_route = True
            except Exception:
                no_route = False
            check('Z1 with no usable route the phone says so (no path through closures)', no_route)
            await page.wait_for_timeout(800)
            bearing = await state(page, 'S.guide && S.guide.bearingDeg')
            check('Z2 no arrow is drawn when there is no route', bearing is None, bearing)
            await page.screenshot(path=f'{SHOTS}/09-no-route.png')
            await page.keyboard.press('Escape'); await page.wait_for_selector('#rp-menu-title')
            await page.get_by_role('button', name='ออกจากโหมดสวมบท').click()
            await page.wait_for_function(f'{R}.store.getState().phase === "off"')

            # Performance, measured: few NPCs vs 3,000.
            for npc in (20, 3000):
                await open_setup(page)
                await choose(page, 'building-1', 5, 0, npc=npc)
                await start(page)
                await page.wait_for_selector('.rp-phone [data-screen="navigate"]', timeout=60000)
                # Real frames (not tick): the menu shows what the page measured while rendering.
                await page.keyboard.down('w'); await page.wait_for_timeout(8000); await page.keyboard.up('w')
                await page.keyboard.press('Escape'); await page.wait_for_selector('#rp-menu-title')
                perf = await state(page, 'S.perf')
                fps = await page.evaluate('new Promise((r) => { let n = 0; const t = performance.now(); const f = () => { n += 1; if (performance.now() - t < 4000) requestAnimationFrame(f); else r(Math.round(n / 4 * 10) / 10); }; requestAnimationFrame(f); })')
                agents = await page.evaluate(f'{R}.runtime.agents.length')
                check(f'Q{npc} measured performance with {agents} NPCs', True, {'renderFps(swiftshader)': fps, **{k: (round(v, 2) if isinstance(v, float) else v) for k, v in perf.items()}})
                await page.get_by_role('button', name='ออกจากโหมดสวมบท').click()
                await page.wait_for_function(f'{R}.store.getState().phase === "off"')

        real_errors = [error for error in errors if 'WebGL' not in error and 'GPU stall' not in error]
        check('E1 no page errors', not real_errors, real_errors[:5])
        await browser.close()
    failed = [name for name, ok, _ in results if not ok]
    print(f'\n{len(results) - len(failed)}/{len(results)} checks passed')
    if failed:
        print('Failed: ' + ' | '.join(failed)); sys.exit(1)

asyncio.run(main())
