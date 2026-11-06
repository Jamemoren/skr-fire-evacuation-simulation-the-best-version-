"""Regression for mobile source lifetime under React StrictMode (run against Vite dev too)."""
import asyncio, json, os, sys, urllib.request
from playwright.async_api import async_playwright
BASE=os.environ.get('QA_BASE','http://127.0.0.1:5199')
API=os.environ.get('QA_API','http://127.0.0.1:8799')
def api(path,token=None,body=None):
    req=urllib.request.Request(API+path,data=None if body is None else json.dumps(body).encode(),headers={'content-type':'application/json',**({'authorization':'Bearer '+token} if token else {})})
    with urllib.request.urlopen(req,timeout=10) as response:return json.loads(response.read())
async def main():
    staff=api('/api/auth/local-staff')['token']
    incident=api('/api/admin/incidents',staff,{'mode':'simulation','title':'QA mobile lifetime'})['incident']
    ticket=api('/api/admin/incidents/'+incident['id']+'/preview-ticket',staff,{})['ticket']
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path=os.environ.get('QA_CHROME'))
        page=await browser.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
        src='/mobile?embed=1&incident='+incident['id']+'&ticket='+ticket
        await page.route('**/__qa_preview',lambda route:route.fulfill(content_type='text/html',body='<iframe src="'+src+'"></iframe>'))
        await page.goto(BASE+'/__qa_preview')
        frame=await (await page.wait_for_selector('iframe')).content_frame()
        if '--reproduce' in sys.argv:
            await page.wait_for_timeout(4000)
            screen=await frame.locator('[data-screen]').get_attribute('data-screen')
            assert screen=='loading',screen
            print('REPRODUCED: Vite StrictMode preview stays loading despite healthy backend',flush=True)
        else:
            await frame.wait_for_selector('[data-screen="ready"]',timeout=15000)
            snapshot=api('/api/admin/snapshot',staff)
            assert snapshot['counts']['testParticipants']==1,snapshot['counts']
            assert snapshot['counts']['openStreams']==1,snapshot['counts']
            print('PASS dev/preview mount: ready, one tester, one stream',flush=True)
            await frame.evaluate('location.reload()')
            await frame.wait_for_selector('[data-screen="ready"]',timeout=15000)
            await page.wait_for_timeout(500)
            snapshot=api('/api/admin/snapshot',staff)
            assert snapshot['counts']['testParticipants']==1,snapshot['counts']
            assert snapshot['counts']['openStreams']==1,snapshot['counts']
            print('PASS reload: saved session recovered, no duplicate stream',flush=True)
        await page.close();await asyncio.sleep(.5)
        assert api('/api/admin/snapshot',staff)['counts']['openStreams']==0
        if '--reproduce' not in sys.argv:
            drill=api('/api/admin/incidents',staff,{'mode':'drill','title':'QA device lifetime'})['incident']
            phone=await browser.new_page();phone.on('pageerror',lambda error:errors.append(str(error)))
            await phone.goto(BASE+'/mobile?join='+drill['joinCode'])
            await phone.wait_for_selector('[data-screen="ready"]',timeout=15000)
            await phone.reload();await phone.wait_for_selector('[data-screen="ready"]',timeout=15000)
            await asyncio.sleep(.5)
            snapshot=api('/api/admin/snapshot',staff)
            assert snapshot['counts']['registeredParticipants']==1,snapshot['counts']
            assert snapshot['counts']['openStreams']==1,snapshot['counts']
            print('PASS device join/reload: ready, one participant, one stream',flush=True)
        await browser.close();await asyncio.sleep(.5)
        assert api('/api/admin/snapshot',staff)['counts']['openStreams']==0
        assert not errors,errors
        print('PASS close: no orphan stream or page errors',flush=True)
asyncio.run(main())
