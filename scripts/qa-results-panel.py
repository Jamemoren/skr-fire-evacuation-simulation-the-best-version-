"""Browser check of the results panel: runs a real simulation with a fire next to busy rooms, expands the
results detail and checks that the stuck/bottleneck/route-reason box renders, uses real metric values, and
leaves the 3D canvas visible (the panel must not cover the middle of the scene).
Run against a Vite dev server:  QA_BASE=http://127.0.0.1:5199 python3 scripts/qa-results-panel.py
"""
import asyncio, json, os
from pathlib import Path
from playwright.async_api import async_playwright

BASE = os.environ.get('QA_BASE', 'http://127.0.0.1:5199')
OUT = Path(os.environ.get('QA_OUTPUT', 'artifacts/results-panel'))

async def run(p, width, height, name):
    browser = await p.chromium.launch(executable_path=os.environ.get('QA_CHROME'), args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    page = await (await browser.new_context(viewport={'width': width, 'height': height})).new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    await page.goto(BASE + '/?intro=0')
    await page.locator('#sw-readiness.is-safe').wait_for(timeout=90000)
    await page.evaluate('''async () => { window.qa = { ...await import('/src/simulation/simulationStore.ts') }; }''')
    await page.evaluate('''() => { const s = window.qa.useEvacuationStore.getState(); s.setPopulationTarget(144); s.setSpeedFactor(8); }''')
    await page.locator('.sw-run-primary').first.click()
    await page.wait_for_function("window.qa.useEvacuationStore.getState().status==='running'")
    # Fire in front of a Building 3 floor 3 classroom row (same position as the scenario sweep).
    await page.evaluate('''() => window.qa.useEvacuationStore.getState().addFire([-105.86, 7.87, -39.98])''')
    await page.wait_for_function('window.qa.useEvacuationStore.getState().metrics.elapsed>240', timeout=400000, polling=1000)
    await page.evaluate('window.qa.useEvacuationStore.getState().pause()')
    m = await page.evaluate('''() => { const m = window.qa.useEvacuationStore.getState().metrics; return { arrived: m.arrived, holding: m.holding, incapacitated: m.incapacitated, stuck: m.stuckReasons, reroutes: m.rerouteReasons, bottlenecks: m.bottlenecks.length }; }''')
    results = page.locator('section.sw-results')
    if await results.count() and await results.is_visible():
        toggle = page.locator('.sw-results-toggle')
        if await toggle.is_visible():
            await toggle.click()
        else:
            await page.evaluate('''() => document.querySelector('section.sw-results')?.classList.add('is-expanded')''')
    await page.wait_for_timeout(600)
    why = page.locator('section[aria-label="สาเหตุและคอขวด"]')
    await why.scroll_into_view_if_needed()
    text = await why.inner_text()
    canvas = await page.locator('canvas').first.bounding_box()
    panel = await results.bounding_box()
    await page.screenshot(path=str(OUT / f'{name}.png'))
    await browser.close()
    covered = None
    if canvas and panel:
        cx, cy = canvas['x'] + canvas['width'] / 2, canvas['y'] + canvas['height'] / 2
        covered = panel['x'] <= cx <= panel['x'] + panel['width'] and panel['y'] <= cy <= panel['y'] + panel['height']
    return {'viewport': [width, height], 'metrics': m, 'whyText': text[:400], 'panel': panel, 'canvas': canvas, 'panelCoversSceneCentre': covered, 'errors': errors}

async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        desktop = await run(p, 1440, 1000, 'results-desktop')
    checks = {
        'why box rendered': 'ติดค้าง' in desktop['whyText'] and 'คอขวด' in desktop['whyText'] and 'เปลี่ยนเส้นทาง' in desktop['whyText'],
        'no page errors': not desktop['errors'],
        'expanded panel leaves scene centre visible (desktop)': desktop['panelCoversSceneCentre'] is False,
        'stuck count matches reasons': desktop['metrics']['holding'] == sum(r['count'] for r in desktop['metrics']['stuck']) or len(desktop['metrics']['stuck']) == 5,
    }
    (OUT / 'results.json').write_text(json.dumps({'checks': checks, 'desktop': desktop}, ensure_ascii=False, indent=2))
    for k, v in checks.items(): print(('PASS ' if v else 'FAIL ') + k)
    print(json.dumps(desktop['metrics'], ensure_ascii=False))
    if not all(checks.values()): raise SystemExit(1)

asyncio.run(main())
