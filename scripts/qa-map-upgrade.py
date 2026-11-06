"""Exact old standard graph upgrades on reload; edited graphs are preserved."""
import asyncio, json, os
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path=os.environ.get('QA_CHROME'),args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        page=await browser.new_page(viewport={'width':1440,'height':1000})
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        await page.goto(os.environ.get('QA_BASE','http://127.0.0.1:5199')+'/?intro=0')
        await page.locator('#sw-readiness.is-safe').wait_for(timeout=60000)
        checks=await page.evaluate('''async()=>{
          const q={...await import('/src/utils/projectFiles.ts'),...await import('/src/simulation/semanticGraph.ts'),...await import('/src/store.ts')};
          const old=q.buildGeneratedSemanticMap(true,undefined,true,true),results=[];
          const check=(name,pass)=>{if(!pass)throw Error(name);results.push(name);};
          old.annotations[0].name='QA preserved label';old.annotations[0].notes='QA preserved note';
          old.connections[0].notes='QA preserved edge note';
          check('old graph differs from current',!q.isDefaultSimulationProject(old));
          const upgraded=q.upgradeStandardSimulationProject(old);
          check('exact old graph upgrades',q.isDefaultSimulationProject(upgraded));
          check('labels and notes preserved',upgraded.annotations[0].name==='QA preserved label'&&upgraded.annotations[0].notes==='QA preserved note'&&upgraded.connections[0].notes==='QA preserved edge note');
          for(const [name,edit] of [
            ['custom node preserved',m=>m.annotations[0].position[0]+=1],
            ['custom waypoint preserved',m=>m.connections[0].waypoints=[[99,99,99]]],
            ['custom calibration preserved',m=>m.calibration.scale=2],
          ]){const map=structuredClone(old);edit(map);check(name,q.upgradeStandardSimulationProject(map)===map);}
          q.useMapperStore.getState().importMap(old);
          return results;
        }''')
        await page.reload()
        await page.locator('#sw-readiness.is-safe').wait_for(timeout=60000)
        assert await page.evaluate('''async()=>{
          const q=await import('/src/utils/projectFiles.ts'),m=q.currentMap();
          return q.isDefaultSimulationProject(m)&&m.annotations[0].name==='QA preserved label'&&m.annotations[0].notes==='QA preserved note';
        }''')
        checks.append('saved old standard reloads ready with labels preserved')
        assert not errors,errors
        print(json.dumps({'passed':len(checks),'checks':checks,'pageErrors':errors}),flush=True)
        await browser.close()

asyncio.run(main())
