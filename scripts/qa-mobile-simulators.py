"""End-to-end simulator A/B against an isolated, local production server (no live incident)."""
import asyncio, json, os, sys, time, urllib.request
from playwright.async_api import async_playwright
if hasattr(sys.stdout, 'reconfigure'): sys.stdout.reconfigure(encoding='utf-8')
BASE=os.environ.get('QA_BASE','http://127.0.0.1:8794')
OUT=os.environ.get('QA_OUT','qa-output/mobile-simulators');os.makedirs(OUT,exist_ok=True)
results=[]
def check(name, ok, detail=''):
    results.append(dict(check=name,passed=bool(ok),detail=detail));print(('PASS ' if ok else 'FAIL ')+name+' '+str(detail),flush=True)
def api(path, token=None, body=None):
    req=urllib.request.Request(BASE+path,data=None if body is None else json.dumps(body).encode(),headers={'content-type':'application/json',**({'authorization':'Bearer '+token} if token else {})})
    with urllib.request.urlopen(req,timeout=20) as response:return json.loads(response.read())
async def wait(fn, seconds=40):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        value=await fn()
        if value:return value
        await asyncio.sleep(.3)
    raise AssertionError('Timed out waiting for browser state')
async def main():
    staff=api('/api/auth/local-staff')['token'];errors=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path=os.environ.get('QA_CHROME'),args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        page=await browser.new_page(viewport={'width':1900,'height':1080});page.set_default_timeout(60000)
        page.on('pageerror',lambda error:errors.append(str(error)))
        await page.goto(BASE+'/?intro=0',wait_until='domcontentloaded')
        await wait(lambda:page.locator('.sw-header').count())
        await page.wait_for_timeout(1500);await page.locator('#sw-population').focus();await page.keyboard.press('Home')
        if await page.get_by_role('button',name='ล้างไฟ',exact=True).is_enabled():await page.get_by_role('button',name='ล้างไฟ',exact=True).click()
        await page.locator('.sw-mobile-guidance-button').click(no_wait_after=True)
        await wait(lambda:page.locator('.mh-status.is-online').count())
        previous_incident=api('/api/admin/snapshot',staff)['activeIncidentId']
        await page.get_by_role('button',name='สร้างสถานการณ์จำลอง',exact=True).click()
        async def tester_ready():
            current=api('/api/admin/snapshot',staff)
            return current['activeIncidentId']!=previous_incident and any(r['isTest'] for r in current['participants'])
        await wait(tester_ready)
        snap=api('/api/admin/snapshot',staff);incident=snap['activeIncidentId'];tester=next(row['participantId'] for row in snap['participants'] if row['isTest'])
        # B: begin on an upper floor; close the used stair while the simulated person walks.
        await page.get_by_role('button',name='วางผู้ทดสอบที่จุดนี้',exact=True).click()
        await page.get_by_role('button',name='เริ่มอพยพในรอบนี้',exact=True).click()
        await page.get_by_role('button',name='เดินอัตโนมัติตามเส้นทาง',exact=True).click()
        await page.locator('.mh-autowalk select').select_option('10')
        await wait(lambda:page.locator('.mh-autowalk [role="status"]').evaluate('(e)=>e.textContent.includes("กำลังเดิน")'))
        await page.get_by_role('button',name='จำลองขาดการเชื่อมต่อ',exact=True).click()
        stopped=api('/api/admin/participants/'+tester+'/view',staff)['me']['location']['nodeId']
        await asyncio.sleep(2)
        check('B3 offline phone pauses automatic walking',api('/api/admin/participants/'+tester+'/view',staff)['me']['location']['nodeId']==stopped)
        await page.get_by_role('button',name='เชื่อมต่อกลับ',exact=True).click()
        await wait(lambda:page.locator('.mh-autowalk [role="status"]').evaluate('(e)=>e.textContent.includes("กำลังเดิน")'))
        view=api('/api/admin/participants/'+tester+'/view',staff);rev=view['advice']['routeRevision']
        groups=api('/api/passages')['groups'];used=next(g for g in groups if set(g['edgeIds']) & set(view['advice']['edgeIds']) and 'stair' in g['id'])
        api('/api/admin/incidents/'+incident+'/closures',staff,{'edgeIds':used['edgeIds'],'closed':True,'reason':'simulator browser QA'})
        await asyncio.sleep(3)
        changed=api('/api/admin/participants/'+tester+'/view',staff)
        check('B1 auto walker receives the changed route during a walk',changed['advice']['routeRevision']>rev and not(set(used['edgeIds'])&set(changed['advice']['edgeIds'])))
        # Complete the same upper-floor journey after rerouting, without moving the tester
        # manually to an outdoor checkpoint or shortening the advised route.
        await wait(lambda:page.locator('.mh-autowalk [role="status"]').evaluate('(e)=>e.textContent.startsWith("ถึงจุดรวมพล")'),120)
        arrived=api('/api/admin/participants/'+tester+'/view',staff)
        check('B2 automatic walking reaches a real route destination and stops',arrived['me']['location']['nodeId']==arrived['advice']['destination']['nodeId'] and await page.get_by_role('button',name='เดินอัตโนมัติตามเส้นทาง',exact=True).count()==1)
        await page.screenshot(path=OUT+'/auto-walk-arrived.png')
        # A: configure before starting the 3D run; the bridge owns this simulation incident.
        bots=page.locator('section[aria-labelledby="mh-g-bots"]')
        for slider in await bots.locator('input[type=range]').all():
            await slider.focus();await page.keyboard.press('End')
        await bots.get_by_role('button',name='เชื่อมบอทกับระบบมือถือ',exact=True).click()
        await page.locator('.sw-header .sw-speed select').select_option('10')
        await page.locator('.sw-header .sw-run-primary').click()
        async def bots_ready():return api('/api/admin/snapshot',staff)['counts'].get('simBotsRouted',0)>0
        await wait(bots_ready,90)
        snap=api('/api/admin/snapshot',staff)
        check('A1 actual backend guidance is delivered to 40 virtual phones',snap['counts']['simBots']==40 and snap['counts']['simBotsRouted']>0,snap['counts'])
        check('A2 phone settings are immutable during a run',await bots.locator('input[type=range]').first.is_disabled())
        await page.locator('.sw-header .sw-run-primary').click()
        # Select a bot via the existing inspector, then return to the phone panel.
        await page.get_by_role('button',name='ปิดแผงนำทางมือถือ (ระบบยังทำงานต่อ)').click()
        await page.get_by_role('tab',name='เหตุผล',exact=True).click()
        await page.locator('.sw-inspector-pick input').fill('0')
        await page.locator('.sw-mobile-guidance-button').click(no_wait_after=True)
        await bots.get_by_role('button',name='ดูมือถือของคนที่เลือกในโมเดล',exact=True).click()
        await wait(lambda:page.locator('.mh-readonly [data-screen]').count())
        check('A3 selected bot phone is rendered read-only',await page.locator('.mh-readonly-bar').count()==1)
        await page.get_by_role('button',name='กลับไปกรอบทดสอบ',exact=True).click()
        # A simulated model fire, without inserting a backend hazard directly.
        await page.get_by_role('button',name='ปีกซ้าย',exact=True).click()
        await page.locator('.sw-header .sw-run-primary').click()
        async def alarm():return any(s['status']=='alarm' and s.get('mode')=='simulated' for s in api('/api/admin/snapshot',staff)['sensors'])
        await wait(alarm,90)
        check('A4 model fire -> simulated sensor -> backend alarm',True)
        await page.get_by_role('button',name='ล้างไฟ',exact=True).click()
        # Fresh no-fire run, preserving the framed tester, can complete without casualties.
        await page.locator('.sw-header .sw-run-reset').click()
        await page.locator('.sw-header .sw-speed select').select_option('50')
        await page.locator('.sw-header .sw-run-primary').click()
        await wait(lambda:bots.locator('tbody tr').count(),180)
        row=await bots.locator('tbody tr').first.inner_text()
        check('A5 completed run records phone setting and seed', 'มือถือ 100%' in row and 'seed' in row,row)
        snap=api('/api/admin/snapshot',staff)
        check('A6 run reset preserves the framed tester session',any(r['participantId']==tester for r in snap['participants']))
        await page.locator('.sw-header .sw-run-reset').click()
        await bots.get_by_role('button',name='หยุดเชื่อมบอท',exact=True).click()
        await page.locator('.sw-header .sw-run-primary').click()
        async def two_rows(): return await bots.locator('tbody tr').count()==2
        await wait(two_rows,180)
        check('A7 no-phone control run records separately', 'ไม่มีมือถือ' in await bots.locator('tbody tr').first.inner_text())
        await page.screenshot(path=OUT+'/bot-comparison.png')
        await page.locator('.sw-header .sw-run-reset').click()
        await page.locator('#sw-population').focus();await page.keyboard.press('End')
        await bots.get_by_role('button',name='เชื่อมบอทกับระบบมือถือ',exact=True).click()
        await page.locator('.sw-header .sw-speed select').select_option('1')
        await page.locator('.sw-header .sw-run-primary').click()
        async def full_roster(): return api('/api/admin/snapshot',staff)['counts'].get('simBotsRouted',0)==3000
        await wait(full_roster,120)
        await page.locator('.sw-header .sw-run-primary').click()
        population=await page.locator('canvas').first.evaluate('(e)=>JSON.parse(e.dataset.simPopulation||"{}")')
        fps=await page.locator('.sw-live-stat.is-fps strong').inner_text()
        check('A8 3000 rendered agents connect to 3000 virtual phones',population.get('total')==3000 and await page.locator('.app-fatal-shell').count()==0,{'population':population,'softwareGLfps':fps})
        await page.screenshot(path=OUT+'/3000-bot-phones.png')
        await page.locator('.sw-header .sw-run-reset').click()
        async def roster_cleared(): return api('/api/admin/snapshot',staff)['counts'].get('simBots',0)==0
        await wait(roster_cleared)
        check('A9 resetting 3D clears virtual occupancy and preserves the tester',any(r['participantId']==tester for r in api('/api/admin/snapshot',staff)['participants']))
        check('Z no uncaught browser errors',not errors,errors)
        await browser.close()
    with open(OUT+'/results.json','w',encoding='utf-8') as handle:json.dump(results,handle,ensure_ascii=False,indent=2)
    assert all(r['passed'] for r in results),results
asyncio.run(main())


