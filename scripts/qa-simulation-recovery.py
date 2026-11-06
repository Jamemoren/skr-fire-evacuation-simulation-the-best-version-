"""Browser regression: blocked saved graph -> durable backup -> startable standard graph.
Run against a Vite dev server; uses an isolated browser context, never user storage.
"""
import asyncio, json, os
from pathlib import Path
from playwright.async_api import async_playwright

BASE = os.environ.get('QA_BASE', 'http://127.0.0.1:5199')
OUT = Path(os.environ.get('QA_OUTPUT', 'artifacts/simulation-recovery'))

async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('QA_CHROME'),
            args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        context = await browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
        page = await context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(BASE + '/?intro=0')
        await page.locator('#sw-readiness.is-safe').wait_for(timeout=60000)
        await page.evaluate('''async () => {
          window.qa = {
            ...await import('/src/utils/projectFiles.ts'),
            ...await import('/src/utils/idb.ts'),
            ...await import('/src/utils/portableProject.ts'),
            ...await import('/src/simulation/semanticGraph.ts'),
            ...await import('/src/simulation/simulationStore.ts'),
            ...await import('/src/store.ts'),
          };
        }''')
        checks = await page.evaluate('''() => {
          const q=window.qa, results=[];
          const check=(name,pass)=>{ if(!pass)throw Error(name); results.push(name); };
          const map=q.buildGeneratedSemanticMap();
          check('standard graph accepted',q.isDefaultSimulationProject(map));
          const roundtrip=JSON.parse(JSON.stringify(map));
          check('JSON roundtrip accepted',q.isDefaultSimulationProject(roundtrip));
          roundtrip.annotations.reverse();roundtrip.connections.reverse();
          roundtrip.annotations[0].name='QA label';roundtrip.annotations[0].visible=false;
          check('order and display metadata accepted',q.isDefaultSimulationProject(roundtrip));
          const optional=structuredClone(map);
          optional.connections.forEach(e=>{if(!e.waypoints?.length)delete e.waypoints;});
          check('optional empty waypoints accepted',q.isDefaultSimulationProject(optional));
          for(const [name,edit] of [
            ['moved node rejected',m=>m.annotations.find(n=>n.type==='classroom').position[0]+=1],
            ['changed width rejected',m=>m.connections[0].width+=1],
            ['closed edge rejected',m=>m.connections[0].enabled=false],
            ['changed waypoint rejected',m=>m.connections[0].waypoints=[[123,0,456]]],
            ['changed calibration rejected',m=>m.calibration.scale=2],
            ['missing node rejected',m=>m.annotations.pop()],
          ]){const m=structuredClone(map);edit(m);check(name,!q.isDefaultSimulationProject(m));}
          q.useEvacuationStore.getState().setWorkMode('editor');
          check('opening editor while idle stays idle',q.useEvacuationStore.getState().status==='idle');
          q.useEvacuationStore.getState().setWorkMode('simulation');
          map.project.name='QA saved custom graph';
          map.annotations.find(n=>n.type==='classroom').position[0]+=1;
          q.useMapperStore.getState().importMap(map);
          window.originalMap=q.currentMap();
          return results;
        }''')
        await page.locator('#sw-readiness.is-risk').wait_for()
        assert not await page.locator('#sw-readiness').get_by_text('6/6', exact=True).count()
        assert await page.locator('.sw-run-primary').first.get_attribute('aria-disabled') == 'true'
        checks.append('mismatched graph blocks start without misleading 6/6')
        # Simulate a browser storage failure: the repair must not overwrite user work.
        await page.evaluate('''() => {
          window.originalOpen=IDBFactory.prototype.open;
          IDBFactory.prototype.open=function(){throw new DOMException('QA storage unavailable','QuotaExceededError');};
        }''')
        repair = page.get_by_role('button', name='สำรองผังเดิมและใช้ผังมาตรฐาน', exact=True)
        await repair.click()
        await page.locator('#sw-readiness [role="alert"]').wait_for()
        assert await page.evaluate('''() => {
          IDBFactory.prototype.open=window.originalOpen;
          const a=window.qa.currentMap(),b=window.originalMap;
          return JSON.stringify(a.annotations)===JSON.stringify(b.annotations)
            && JSON.stringify(a.connections)===JSON.stringify(b.connections)
            && window.qa.useMapperStore.getState().projectBusy===false;
        }''')
        checks.append('failed backup preserves original map and releases busy state')
        async with page.expect_download() as event:
            await repair.click()
        download = await event.value
        await download.save_as(str(OUT / download.suggested_filename))
        await page.locator('#sw-readiness.is-safe').wait_for()
        result = await page.evaluate('''async () => {
          const q=window.qa,b=await q.loadSimulationBackup(),decoded=await q.decodeProject(b.blob);
          if(JSON.stringify(decoded.map.annotations)!==JSON.stringify(window.originalMap.annotations)
            || JSON.stringify(decoded.map.connections)!==JSON.stringify(window.originalMap.connections)
            || JSON.stringify(decoded.map.calibration)!==JSON.stringify(window.originalMap.calibration))throw Error('backup differs');
          if(!q.isDefaultSimulationProject(q.currentMap()))throw Error('repair not standard');
          if(q.useEvacuationStore.getState().workMode!=='simulation'
            ||q.useEvacuationStore.getState().status!=='idle')throw Error('repair not idle simulation');
          if(q.currentMap().project.name!=='QA saved custom graph')throw Error('lost project metadata');
          return {nodes:decoded.map.annotations.length,edges:decoded.map.connections.length,backupBytes:b.blob.size};
        }''')
        checks.append('backup committed, downloaded, decodable with exact nodes/edges/calibration')
        assert await page.locator('.sw-run-primary').first.get_attribute('aria-disabled') is None
        await page.evaluate('window.qa.useEvacuationStore.getState().setPopulationTarget(40)')
        await page.locator('.sw-run-primary').first.click()
        await page.wait_for_function("window.qa.useEvacuationStore.getState().status==='running'")
        await page.wait_for_function('window.qa.useEvacuationStore.getState().metrics.elapsed>0', timeout=30000)
        await page.evaluate('window.qa.useEvacuationStore.getState().pause()')
        checks.append('actual start button runs simulation and advances time')
        # Reset, reload, and import the backup to prove persistence and recoverability.
        await page.evaluate('window.qa.useEvacuationStore.getState().reset()')
        await page.reload()
        await page.locator('#sw-readiness.is-safe').wait_for(timeout=60000)
        async with page.expect_download() as repeated:
            await page.get_by_role('button', name='ดาวน์โหลดผังเดิมที่สำรองล่าสุด').click()
        assert (await repeated.value).suggested_filename == download.suggested_filename
        checks.append('standard graph and downloadable backup survive reload')
        await page.screenshot(path=str(OUT / 'ready-after-recovery.png'))
        restored = await page.evaluate('''async () => {
          const q={...await import('/src/utils/projectFiles.ts'),...await import('/src/utils/idb.ts')};
          const b=await q.loadSimulationBackup();
          await q.importWorkspaceFile(new File([b.blob],b.name));
          return !q.isDefaultSimulationProject(q.currentMap())&&q.currentMap().project.name==='QA saved custom graph';
        }''')
        assert restored
        checks.append('backup imports successfully to continue editing the original graph')
        assert not errors, errors
        report={'passed':len(checks),'checks':checks,'backup':result,'pageErrors':errors}
        (OUT / 'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(report,ensure_ascii=False),flush=True)
        await browser.close()

asyncio.run(main())
