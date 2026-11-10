"""Load time and smoothness, before vs after, under the same conditions.

  npx vite preview --port 4174 --outDir <before-dist>   &   npx vite preview --port 4173   (after)
  QA_CHROME=… python3 scripts/perf-compare.py http://127.0.0.1:4174 http://127.0.0.1:4173

Each build is opened 3 times in a fresh browser (no cache). Measured in the page:
  ready    — navigation start → the readiness card exists (the page can be used)
  js       — JavaScript bytes transferred until ready
  idle fps — frames per second over 6 s with the camera still (whole campus view)
  run fps  — frames per second over 8 s while 1,500 people are simulated at 10×
For the “after” build also: opening the presentation and switching 3 slides (longest frame).
Headless software rendering (SwiftShader) is far slower than a real GPU: compare the two columns
with each other, not with a real computer.
"""
import asyncio, json, os, statistics, sys
from playwright.async_api import async_playwright

CHROME = os.environ.get('QA_CHROME')
ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
FPS = """(ms) => new Promise((resolve) => { let n = 0, worst = 0, last = performance.now(); const t0 = last;
  const tick = (now) => { n++; worst = Math.max(worst, now - last); last = now; if (now - t0 < ms) requestAnimationFrame(tick); else resolve({ fps: n * 1000 / (now - t0), worstMs: worst }); };
  requestAnimationFrame(tick); })"""

async def measure(p, base, present):
    browser = await p.chromium.launch(executable_path=CHROME, args=ARGS)
    ctx = await browser.new_context(viewport={'width': 1440, 'height': 900})
    await ctx.add_init_script("try{sessionStorage.setItem('skr-cinematic-intro','seen');localStorage.setItem('skr-guide-seen','1')}catch(e){}")
    page = await ctx.new_page(); page.set_default_timeout(180000)
    await page.goto(base + '/?guide=0')
    await page.locator('#sw-readiness').wait_for()
    ready = await page.evaluate("()=>performance.now()")
    js_bytes = await page.evaluate("()=>performance.getEntriesByType('resource').filter(e=>/\\.js(\\?|$)/.test(e.name)).reduce((s,e)=>s+(e.encodedBodySize||e.transferSize||0),0)")
    await page.wait_for_timeout(3000)
    idle = await page.evaluate(FPS, 6000)
    await page.evaluate("()=>{}")
    await page.locator('[data-tour="population"]').click()
    await page.locator('.sw-run-primary').click()
    await page.locator('.sw-speed select').select_option('10')
    await page.wait_for_timeout(2000)
    run = await page.evaluate(FPS, 8000)
    out = {'readyMs': round(ready), 'jsKB': round(js_bytes / 1024), 'idleFps': round(idle['fps'], 2), 'runFps': round(run['fps'], 2), 'runWorstMs': round(run['worstMs'])}
    if present:
        await page.locator('.sw-run-primary').click()  # pause
        t0 = await page.evaluate("()=>performance.now()")
        await page.locator('[data-guide-target="present"]').click()
        await page.locator('.pz-root').wait_for()
        out['presentOpenMs'] = round(await page.evaluate("()=>performance.now()") - t0)
        worst = 0
        for _ in range(3):
            await page.keyboard.press('ArrowRight')
            res = await page.evaluate(FPS, 3000)
            worst = max(worst, res['worstMs'])
        out['slideSwitchWorstFrameMs'] = round(worst)
        await page.keyboard.press('Escape')
    await browser.close()
    return out

async def main():
    before, after = sys.argv[1], sys.argv[2]
    rows = {'before': [], 'after': []}
    async with async_playwright() as p:
        for i in range(3):
            for name, base in (('before', before), ('after', after)):  # interleaved so load on the machine is shared fairly
                r = await measure(p, base, present=(name == 'after'))
                rows[name].append(r)
                print(name, i + 1, json.dumps(r), flush=True)
    summary = {}
    for name, items in rows.items():
        summary[name] = {key: round(statistics.median([item[key] for item in items if key in item]), 2) for key in items[0]}
    print('\nmedian of 3:\n' + json.dumps(summary, indent=1, ensure_ascii=False))

asyncio.run(main())
