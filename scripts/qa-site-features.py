"""Browser check (no backend running): first-visit guide, in-browser phone backend, model-editor demo
end to end (edits → simulation → clean-up), and the floor-3 bridge view.
Run against a Vite dev server WITHOUT `npm run server`:
  QA_BASE=http://127.0.0.1:5199 QA_CHROME=/path/to/chrome python3 scripts/qa-site-features.py
"""
import asyncio, json, os
from pathlib import Path
from playwright.async_api import async_playwright

BASE = os.environ.get('QA_BASE', 'http://127.0.0.1:5199')
OUT = Path(os.environ.get('QA_OUTPUT', 'artifacts/site-features'))
checks = {}
def check(name, ok, detail=''):
    checks[name] = bool(ok)
    print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail != '' else ''))

async def new_page(p, first_visit=False):
    browser = await p.chromium.launch(executable_path=os.environ.get('QA_CHROME'), args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    context = await browser.new_context(viewport={'width': 1440, 'height': 950})
    # The opening film is skipped (seen this session); the first-visit guide is not.
    await context.add_init_script("try{sessionStorage.setItem('skr-cinematic-intro','seen')}catch(e){}")
    page = await context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)
    await page.goto(BASE + ('/' if first_visit else '/?guide=0'))
    await page.locator('#sw-readiness').wait_for(timeout=120000)
    await page.evaluate("""async () => { window.qa = { ...await import('/src/simulation/simulationStore.ts'), ...await import('/src/store.ts'), ...await import('/src/simulation/runtime.ts') }; }""")
    return browser, page, errors

async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        # 1. first visit
        browser, page, errors = await new_page(p, first_visit=True)
        dialog = page.locator('dialog.user-guide.is-welcome')
        await dialog.wait_for(timeout=20000)
        text = await dialog.inner_text()
        check('G1 first visit opens the guide in welcome mode', await dialog.is_visible(), text[:80].replace('\n', ' '))
        await page.screenshot(path=str(OUT / 'first-visit-guide.png'))
        await dialog.get_by_role('button', name='อ่านคู่มือทีละบท').click()
        nav = await page.locator('.user-guide-nav button').all_inner_texts()
        check('G2 the guide covers every part of the site (10 lessons incl. roleplay, phone, editor, files)', len(nav) == 10 and any('สวมบท' in t for t in nav) and any('มือถือ' in t for t in nav) and any('แก้ไขโมเดล' in t for t in nav), nav)
        await page.keyboard.press('Escape')
        await page.wait_for_timeout(500)
        seen = await page.evaluate("localStorage.getItem('skr-guide-seen')")
        check('G3 the welcome is remembered (not shown again)', seen == '1', seen)
        mode = await page.evaluate("async()=>{await window.__evacBackend.ready;return window.__evacBackend.mode()}")
        check('B1 no server running → in-browser backend', mode == 'browser', mode)
        check('B2 no console errors on load (no failed /api probe)', not errors, errors[:3])
        await browser.close()

        # 2. editor demo end to end
        browser, page, errors = await new_page(p)
        await page.get_by_role('button', name='แก้ไขแบบจำลอง').first.click()
        await page.get_by_role('button', name='▶ สาธิตการแก้ไข').click()
        card = page.locator('.editor-demo')
        await card.wait_for()
        await card.get_by_role('button', name='เริ่ม →').click()
        for label in ['1 · ปักจุดจำลองไฟ', '2 · กำหนดพื้นที่ห้ามผ่าน', '3 · ปิดเส้นทาง', '4 · กำหนดจำนวนคนในห้อง']:
            await card.locator('h2', has_text=label).wait_for()
            await card.get_by_role('button', name='ทำให้ดู').click()
            await page.wait_for_timeout(400)
            state = await card.locator('.editor-demo-state').inner_text()
            check(f'D {label}: done by the demo', '✓' in state, state)
            await card.get_by_role('button', name='ถัดไป →').click()
        await page.screenshot(path=str(OUT / 'editor-demo.png'))
        await card.locator('h2', has_text='5 · จำลองด้วยผังที่แก้').wait_for()
        await card.get_by_role('button', name='เริ่มจำลองด้วยผังนี้').click()
        try:
            await page.wait_for_function("window.qa.useEvacuationStore.getState().status==='running'", timeout=90000)
        except Exception:
            diag = await page.evaluate("()=>{const s=window.qa.useEvacuationStore.getState();return {status:s.status,err:s.error??s.startError??null,card:document.querySelector('.editor-demo')?.innerText?.slice(0,300),ready:document.querySelector('.sw-readiness, .sw-editor-applied')?.innerText?.slice(0,400)}}")
            print('DIAG', diag, 'ERRORS', errors[:5])
            await page.screenshot(path=str(OUT / 'editor-demo-start-fail.png'))
            raise
        applied = await page.locator('.sw-editor-applied').inner_text()
        run = await page.evaluate("""() => { const rt = window.qa.evacuationRuntime; return { fires: rt.fires.filter(f=>f.sourceMarkerId).length, closed: rt.closedEdges.size, door: rt.closedEdges.has('edge-center-stair-door'), people: rt.agents.length, room: rt.agents.filter(a=>a.roomId==='b1-f9-pink-1').length }; }""")
        check('D5 the run applies the editor edits (fire, closures, 40 people in room 901)', run['fires'] == 1 and run['door'] and run['closed'] >= 4 and run['room'] == 40, run)
        check('D5 the start card lists what is applied', 'ใช้การแก้ไขจากหน้าแก้ไขโมเดล' in applied and 'จุดไฟ' in applied, applied[:200].replace('\n', ' | '))
        await page.screenshot(path=str(OUT / 'editor-demo-run.png'))
        await page.evaluate("window.qa.useEvacuationStore.getState().pause()")
        await page.get_by_role('button', name='แก้ไขแบบจำลอง').first.click()
        await card.locator('h2', has_text='6 · ล้างการสาธิต').wait_for()
        await card.get_by_role('button', name='ล้างการสาธิต').click()
        await page.wait_for_timeout(500)
        after = await page.evaluate("""() => { const m = window.qa.useMapperStore.getState(); return { extra: m.annotations.filter(a=>a.type==='fire-source'||(a.type==='restricted-area'&&a.id!=='site-central-shrine')).length, door: m.connections.find(c=>c.id==='edge-center-stair-door').enabled, room: m.annotations.find(a=>a.id==='b1-f9-pink-1').peopleCount }; }""")
        check('D6 clean-up removes the demo markers and restores the passage', after['extra'] == 0 and after['door'] is True, after)
        await page.get_by_role('button', name='← กลับระบบจำลองการอพยพ').click()
        await page.wait_for_timeout(800)
        ready = await page.locator('#sw-readiness').inner_text()
        check('D6 after clean-up the simulation is ready again with the standard layout', 'พร้อมเริ่มการจำลอง' in ready and 'ใช้การแก้ไข' not in ready, ready[:120].replace('\n', ' '))
        leftover = await page.evaluate("() => { const s = window.qa.useEvacuationStore.getState(); const rt = window.qa.evacuationRuntime; return { status: s.status, demoFires: rt.fires.filter(f=>f.sourceMarkerId).length, door: rt.closedEdges.has('edge-center-stair-door') }; }")
        check('D6 clean-up also ends the demo run and removes its fire and closures', leftover['status'] == 'idle' and leftover['demoFires'] == 0 and not leftover['door'], leftover)
        check('D7 no page errors during the demo', not [e for e in errors if not e.startswith('console: Failed to load resource')], errors[:3])

        # 3. bridge on floor 3
        await page.get_by_role('button', name='ทางเชื่อม').first.click()
        await page.wait_for_timeout(6000)
        await page.screenshot(path=str(OUT / 'bridge-floor-3.png'))
        await browser.close()

        # 4. editor network edits checked against the real 3D model (walls, floors, trees)
        browser, page, errors = await new_page(p)
        await page.evaluate("async () => { Object.assign(window.qa, await import('/src/simulation/modelPhysics.ts'), await import('/src/simulation/editorScenario.ts'), await import('/src/simulation/graph.ts')); }")
        await page.wait_for_function("!!window.qa.modelPhysics()", timeout=120000)
        calib = await page.evaluate('''() => {
          const P = window.qa.modelPhysics(), g = window.qa.createEvacuationGraph(), nodes = new Map(g.nodes.map(n => [n.id, n]));
          const bad = [];
          for (const e of g.edges) { if (e.kind === 'stair') continue; const pts = [nodes.get(e.from).position, ...(e.waypoints ?? []), nodes.get(e.to).position];
            for (let i = 1; i < pts.length; i++) { if (Math.abs(pts[i][1] - pts[i-1][1]) > 0.6) continue; const r = window.qa.walkProblem([pts[i-1], pts[i]], P); if (r) { bad.push(e.id + ': ' + r); break; } } }
          return { edges: g.edges.filter(e => e.kind !== 'stair').length, bad };
        }''')
        check('X1 the wall/floor check passes every standard (non-stair) passage — no false alarms', not calib['bad'], {'edges': calib['edges'], 'bad': calib['bad'][:4]})
        await page.get_by_role('button', name='แก้ไขแบบจำลอง').first.click()
        await page.wait_for_timeout(1500)
        status = page.locator('.editor-sim-status > button')
        check('X2 the editor shows that the standard map can be simulated', 'จำลองได้' in await status.inner_text(), await status.inner_text())
        # a door point moved 2 m along the corridor: the room's front wall is in the way
        moved = await page.evaluate('''() => { const m = window.qa.useMapperStore.getState(); const edge = m.connections.find(e => e.fromId === 'b1-f5-pink-2'); const door = m.annotations.find(a => a.id === edge.toId);
          m.updateAnnotation(door.id, { locked: false }); window.qa.useMapperStore.getState().updateAnnotation(door.id, { position: [door.position[0] + 2, door.position[1], door.position[2]] }); return door.id; }''')
        await page.wait_for_timeout(400)
        await status.click()
        panel = await page.locator('.editor-sim-status-panel').inner_text()
        check('X3 a door moved into the wall is refused, naming what it hits', 'จำลองยังไม่ได้' in await status.inner_text() and 'ชน' in panel, panel[:240].replace('\n', ' | '))
        await page.screenshot(path=str(OUT / 'editor-door-into-wall.png'))
        await page.evaluate('''(id) => { const m = window.qa.useMapperStore.getState(); const door = m.annotations.find(a => a.id === id); m.updateAnnotation(id, { position: [door.position[0] - 2, door.position[1], door.position[2]] }); }''', moved)
        # a new walkway point in the middle of a corridor, and two new passages to it
        made = await page.evaluate('''() => {
          const g = window.qa.createEvacuationGraph(), nodes = new Map(g.nodes.map(n => [n.id, n]));
          const pick = g.edges.find(e => e.kind === 'corridor' && e.twoWay && e.floorFrom === 5 && e.floorTo === 5 && !(e.waypoints ?? []).length
            && nodes.get(e.from).type === 'corridor' && nodes.get(e.to).type === 'corridor');
          if (!pick) return null;
          const a = nodes.get(pick.from).position, b = nodes.get(pick.to).position, mid = a.map((v, k) => (v + b[k]) / 2);
          const m = window.qa.useMapperStore.getState();
          m.openDraftFromHit({ position: mid, worldPosition: mid, normal: [0, 1, 0], objectName: '', objectPath: '', materialName: '', triangleCount: 0 }, 'navigation-node');
          window.qa.useMapperStore.getState().updateDraft({ name: 'จุดทางเดินใหม่ (ทดสอบ)' });
          window.qa.useMapperStore.getState().saveDraft();
          const id = window.qa.useMapperStore.getState().annotations.at(-1).id;
          window.qa.useMapperStore.getState().addConnection(pick.from, id);
          window.qa.useMapperStore.getState().addConnection(id, pick.to);
          return { id, edge: pick.id };
        }''')
        await page.wait_for_timeout(500)
        text = await status.inner_text()
        panel = await page.locator('.editor-sim-status-panel').inner_text() if await page.locator('.editor-sim-status-panel').count() else ''
        check('X4 a new corridor point with two new passages is accepted after the 3D check', made and 'จำลองได้' in text and 'เส้นทางใหม่ 2 เส้น' in panel, {'made': made, 'status': text, 'panel': panel[:240]})
        # a new passage straight through a classroom's side wall
        await page.evaluate('''() => { window.qa.useMapperStore.getState().addConnection('b1-f5-pink-2', 'b1-f5-pink-3'); }''')
        await page.wait_for_timeout(500)
        panel = await page.locator('.editor-sim-status-panel').inner_text()
        check('X5 a new passage through a wall is refused, naming the wall', 'จำลองยังไม่ได้' in await status.inner_text() and 'ชนผนัง' in panel, panel[:240].replace('\n', ' | '))
        await page.evaluate('''() => { const m = window.qa.useMapperStore.getState(); const c = m.connections.at(-1); m.deleteConnection(c.id); }''')
        await page.wait_for_timeout(300)
        # run with the accepted edits: the run's network has the new point and passages
        await page.screenshot(path=str(OUT / 'editor-new-passage-status.png'))
        await page.evaluate("window.qa.useEvacuationStore.getState().setWorkMode('simulation')")
        await page.wait_for_timeout(800)
        await page.evaluate("window.qa.useEvacuationStore.getState().start()")
        await page.wait_for_function("window.qa.useEvacuationStore.getState().status==='running'", timeout=60000)
        run = await page.evaluate('''(made) => { const rt = window.qa.evacuationRuntime; rt.advance(30); return { node: rt.graph.nodes.some(n => n.id === made.id), edges: rt.graph.edges.filter(e => e.from === made.id || e.to === made.id).length, topo: rt.getMetrics().topologyViolations }; }''', made)
        check('X6 the run uses the edited network (new point + 2 passages), physics valid', run['node'] and run['edges'] == 2 and run['topo'] == 0, run)
        check('X7 no page errors with network edits', not [e for e in errors if not e.startswith('console: Failed to load resource')], errors[:3])
        await browser.close()

    (OUT / 'results.json').write_text(json.dumps(checks, ensure_ascii=False, indent=2))
    failed = [k for k, v in checks.items() if not v]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
    if failed: raise SystemExit(1)

asyncio.run(main())
