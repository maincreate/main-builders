import {readFileSync,writeFileSync,mkdirSync,chmodSync,statSync,realpathSync,readdirSync,mkdtempSync,rmSync} from "node:fs";
import {join,resolve,isAbsolute,sep,dirname,basename} from "node:path";
import {homedir,hostname,platform,arch,cpus,totalmem,freemem,uptime,tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {installArduinoCli,installedArduinoCli,isExactArduinoVersion} from "./sdk_install.mjs";
import {
 installEspIdf,verifyEspIdf,installAndroidSdk,verifyAndroidSdk,installAndroidAdb,verifyAndroidAdb,
 buildEspIdfProject,buildAndroidApp,flashEsp32,backupEsp32Firmware,restoreEsp32Firmware,
 deployAndroidApk,backupAndroidApk,restoreAndroidApk,removeToolkit
} from "./toolkit_runtime.mjs";

const configDir=process.env.MAIN_RUNNER_STATE_DIR||join(homedir(),".maincreate");
const path=join(configDir,"runner.json");
const command=process.argv[2]||"run",endpoint=process.env.MAIN_CONTROLLER_URL||"http://portal:3000";
const os={win32:"windows",darwin:"macos",linux:"linux"}[platform()];
const architecture={x64:"x64",arm64:"arm64"}[arch()];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function ensureUrl(){
 const u=new URL(endpoint);
 if(!["https:","http:"].includes(u.protocol))throw new Error("Unsupported controller scheme");
 if(u.protocol==="http:"&&!["127.0.0.1","localhost","portal","controller"].includes(u.hostname)&&process.env.MAIN_ALLOW_INSECURE_LAN!=="true")
  throw new Error("Use HTTPS for remote controller or explicitly permit isolated LAN HTTP");
 return u;
}
async function post(route,obj,token){
 const origin=ensureUrl(),url=new URL(route,origin);
 if(url.origin!==origin.origin)throw new Error("Cross-origin controller URL rejected");
 const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json",
  ...(token?{authorization:"Bearer "+token}:{})},body:JSON.stringify(obj),signal:AbortSignal.timeout(30000)});
 const data=await response.json().catch(()=>({error:"Unexpected controller response"}));
 if(!response.ok)throw new Error("Controller HTTP "+response.status+" ("+(data.error||"request rejected")+")");
 return data;
}
async function enroll(){
 if(!os||!architecture)throw new Error("Unsupported runner platform or architecture");
 const invite=process.env.MAIN_ENROLLMENT_TOKEN||"";
 if(invite.length<32)throw new Error("MAIN_ENROLLMENT_TOKEN required for enrollment");
 const name=(process.env.MAIN_RUNNER_NAME||hostname()).slice(0,64);
 const r=await post("/api/agent/enroll",{token:invite,name,os,arch:architecture});
 mkdirSync(configDir,{recursive:true,mode:0o700});
 writeFileSync(path,JSON.stringify({id:r.id,token:r.token,url:endpoint,name,os,arch:architecture},null,2),{mode:0o600});
 chmodSync(path,0o600);
 console.log("Enrolled "+name+" ("+r.id+") to "+endpoint+". Execution requires explicit controller and runner opt-in.");
}
function approvedCheckout(repo){
 if(process.env.MAIN_RUNNER_ENABLE_BUILDS!=="1")throw new Error("Runner builds disabled by operator");
 let projects;
 try{projects=JSON.parse(process.env.MAIN_RUNNER_PROJECTS_JSON||"{}");}
 catch{throw new Error("Invalid MAIN_RUNNER_PROJECTS_JSON");}
 if(!projects||typeof projects!=="object"||Array.isArray(projects)||
  !Object.hasOwn(projects,repo)||typeof projects[repo]!=="string")
  throw new Error("Repository not in this runner's approved local project map");
 const dir=projects[repo];
 if(!isAbsolute(dir))throw new Error("Project checkout must be an absolute path");
 const actual=realpathSync(resolve(dir));
 if(!statSync(actual).isDirectory())throw new Error("Checkout is not a directory");
 return actual;
}
async function processTool(bin,args,cwd,timeoutMs){
 return new Promise((resolve,reject)=>{
  const child=spawn(bin,args,{cwd,shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let combined="",wasKilled=false;
  const capture=chunk=>{combined+=(chunk?.toString("utf8")||"");if(combined.length>20000)combined=combined.slice(-20000);};
  child.stdout.on("data",capture);child.stderr.on("data",capture);
  const timer=setTimeout(()=>{wasKilled=true;child.kill("SIGKILL");},timeoutMs);
  child.once("error",e=>{clearTimeout(timer);reject(new Error("Approved command failed: "+e.message));});
  child.once("close",code=>{clearTimeout(timer);
   if(wasKilled)return reject(new Error("Approved command timed out"));
   if(code!==0)return reject(new Error("Approved command failed (exit "+code+"): "+combined.slice(-4000)));
   resolve(combined);
  });
 });
}
async function uploadAsset(config,jobId,name,mime,data){
 if(!Buffer.isBuffer(data))data=Buffer.from(data);
 if(data.length<1||data.length>64*1024*1024)throw new Error("Artifact outside allowed size");
 const base={id:config.id,job_id:jobId};
 const begin=await post("/api/agent/assets",{...base,action:"begin",name,mime,size:data.length},config.token);
 const id=begin.asset.id,chunkSize=Math.min(48*1024,begin.max_chunk_bytes||48*1024);
 for(let off=0;off<data.length;off+=chunkSize){
  await post("/api/agent/assets",{...base,action:"chunk",asset_id:id,offset:off,
   content_base64:data.subarray(off,off+chunkSize).toString("base64")},config.token);
 }
 const digest=createHash("sha256").update(data).digest("hex");
 await post("/api/agent/assets",{...base,action:"finish",asset_id:id,sha256:digest},config.token);
 return id;
}
function gatherFirmware(dir){
 const build=join(dir,"build"),items=[];
 try{
  for(const name of readdirSync(build)){
   if(!name.endsWith(".bin")||!/^[A-Za-z0-9_.-]+\.bin$/.test(name))continue;
   const file=realpathSync(join(build,name));
   if(!file.startsWith(realpathSync(build)+sep))continue;
   const stat=statSync(file);if(!stat.isFile()||stat.size<1||stat.size>8*1024*1024)continue;
   items.push({name,data:readFileSync(file)});
   if(items.length>=5)break;
  }
 }catch(e){if(e.code!=="ENOENT")throw e;}
 return items;
}

async function downloadJobArtifacts(config,job,destination){
 const sourceJobId=job.parameters?.source_job_id;
 if(typeof sourceJobId!=="string"||!/^[a-f0-9]{32}$/.test(sourceJobId))
  throw new Error("A completed source job is required for artifact handoff");
 const base={id:config.id,job_id:job.id,source_job_id:sourceJobId};
 const listed=await post("/api/agent/assets",{...base,action:"list"},config.token);
 if(!Array.isArray(listed.assets)||!listed.assets.length)throw new Error("Source job has no completed artifacts");
 mkdirSync(destination,{recursive:true,mode:0o700});
 const result=[];
 for(const asset of listed.assets){
  if(!/^(?:maincreate-|base\.apk$|split-\d+\.apk$)/.test(asset.name))continue;
  if(!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>64*1024*1024)throw new Error("Source artifact exceeds allowed size");
  const chunks=[];let offset=0;
  while(offset<asset.size){
   const part=await post("/api/agent/assets",{...base,action:"get",asset_id:asset.id,offset,length:48*1024},config.token);
   const bytes=Buffer.from(part.content_base64||"","base64");
   if(!bytes.length||part.offset!==offset||part.asset?.id!==asset.id)throw new Error("Artifact download offset or identity mismatch");
   chunks.push(bytes);offset+=bytes.length;
   if(offset>asset.size)throw new Error("Artifact download exceeded declared size");
  }
  const data=Buffer.concat(chunks,offset);
  if(data.length!==asset.size||createHash("sha256").update(data).digest("hex")!==asset.sha256)
   throw new Error("Source artifact checksum mismatch: "+asset.name);
  const target=join(destination,basename(asset.name));
  writeFileSync(target,data,{mode:0o600,flag:"wx"});
  result.push({id:asset.id,name:asset.name,path:target,mime:asset.mime,sha256:asset.sha256,size:asset.size});
 }
 if(!result.length)throw new Error("No eligible firmware or Android artifacts were found in the source job");
 return result;
}
async function verifiedCheckout(job){
 const repo=job.parameters?.repository;
 if(typeof repo!=="string")throw new Error("Repository missing");
 const checkout=approvedCheckout(repo);
 if(typeof job.parameters?.revision!=="string"||!/^[a-f0-9]{40}$/i.test(job.parameters.revision))
  throw new Error("An exact Git revision must be approved before building");
 const actual=(await processTool("git",["rev-parse","HEAD"],checkout,20000)).trim();
 if(actual.toLowerCase()!==job.parameters.revision.toLowerCase())
  throw new Error("Checkout revision differs from approved plan; update the checkout separately");
 const dirty=(await processTool("git",["status","--porcelain=v1","--untracked-files=normal"],checkout,20000)).trim();
 if(dirty)throw new Error("Approved checkout has modified or untracked files; use a clean pinned checkout");
 return checkout;
}
async function localAdbPath(){
 try{return (await verifyAndroidSdk()).adb;}catch{}
 try{return (await verifyAndroidAdb()).adbPath;}catch{}
 throw new Error("Android ADB toolkit is not installed and verified on this builder");
}

async function executeJob(config,job){
 const results=[],out=[],ids=[],steps=job.steps||[];
 let failed=false;
 for(const step of steps){
  if(failed){results.push({capability:step.capability,status:"skipped"});continue;}
  try{
   if(step.capability==="host.snapshot"){
    const report={host:config.name,os,architecture,hostname:hostname(),cpus:cpus().length,
     totalMemoryBytes:totalmem(),freeMemoryBytes:freemem(),uptimeSeconds:Math.floor(uptime()),
     node:process.version,observedAt:new Date().toISOString()};
    out.push("Host snapshot recorded");
    ids.push(await uploadAsset(config,job.id,"host-snapshot.json","application/json",
     Buffer.from(JSON.stringify(report,null,2))));

   }else if(step.capability==="sdk.esp_idf.install"){
    const installed=await installEspIdf({version:job.parameters?.toolkit_version,os,architecture});
    out.push("ESP-IDF "+installed.version+" installed and verified on "+os+"/"+architecture);
   }else if(step.capability==="sdk.android.install"){
    const installed=await installAndroidSdk({version:job.parameters?.toolkit_version,os,architecture});
    out.push("Android SDK "+installed.version+" installed and verified on "+os+"/"+architecture);
   }else if(step.capability==="sdk.android_adb.install"){
    const installed=await installAndroidAdb({os,architecture});
    out.push("Android ADB device adapter "+installed.version+" installed and verified");
   }else if(step.capability==="sdk.toolkit.cleanup"){
    const result=removeToolkit({family:job.parameters?.toolkit_id,version:job.parameters?.toolkit_version,dryRun:false});
    out.push("Removed toolkit "+result.family+" "+result.version+": "+result.paths.join(", "));
   }else if(step.capability==="firmware.esp_idf.build"){
    const checkout=await verifiedCheckout(job),version=job.parameters?.toolkit_version;
    const built=await buildEspIdfProject({projectDir:checkout,version});
    built.manifest.sourceRevision=job.parameters.revision;
    writeFileSync(built.manifestPath,JSON.stringify(built.manifest,null,2)+"\\n",{mode:0o600});
    ids.push(await uploadAsset(config,job.id,"maincreate-firmware.bin","application/octet-stream",readFileSync(built.imagePath)));
    ids.push(await uploadAsset(config,job.id,"maincreate-firmware-manifest.json","application/json",readFileSync(built.manifestPath)));
    out.push(built.log);
   }else if(step.capability==="android.app.build"){
    const checkout=await verifiedCheckout(job);
    const built=await buildAndroidApp({projectDir:checkout,version:job.parameters?.toolkit_version,targetProfile:job.parameters?.target_profile});
    built.manifest.sourceRevision=job.parameters.revision;
    writeFileSync(built.manifestPath,JSON.stringify(built.manifest,null,2)+"\\n",{mode:0o600});
    for(const apk of built.apks)ids.push(await uploadAsset(config,job.id,apk.name,"application/vnd.android.package-archive",readFileSync(apk.path)));
    ids.push(await uploadAsset(config,job.id,"maincreate-android-manifest.json","application/json",readFileSync(built.manifestPath)));
    out.push(built.log+"; uploaded "+built.apks.length+" APK(s)");
   }else if(step.capability==="firmware.esp_idf.flash"){
    const temp=mkdtempSync(join(tmpdir(),"maincreate-flash-"));
    try{
     const assets=await downloadJobArtifacts(config,job,temp);
     const image=assets.find(a=>a.name==="maincreate-firmware.bin"),manifestAsset=assets.find(a=>a.name==="maincreate-firmware-manifest.json");
     if(!image||!manifestAsset)throw new Error("Source build is missing the merged firmware image or manifest");
     const manifest=JSON.parse(readFileSync(manifestAsset.path,"utf8"));
     const result=await flashEsp32({port:job.parameters?.device_port,version:job.parameters?.toolkit_version,
      imagePath:image.path,manifest});
     out.push(result.output);
    }finally{rmSync(temp,{recursive:true,force:true});}
   }else if(step.capability==="firmware.esp_idf.backup"){
    const temp=mkdtempSync(join(tmpdir(),"maincreate-esp-backup-"));
    try{
     const backup=await backupEsp32Firmware({port:job.parameters?.device_port,version:job.parameters?.toolkit_version,
      outputPath:join(temp,"maincreate-esp32-backup.bin"),deviceSerial:job.parameters?.device_serial});
     ids.push(await uploadAsset(config,job.id,"maincreate-esp32-backup.bin","application/octet-stream",readFileSync(backup.imagePath)));
     ids.push(await uploadAsset(config,job.id,"maincreate-esp32-backup.json","application/json",readFileSync(backup.manifestPath)));
     out.push("Firmware image backed up: "+backup.manifest.flashBytes+" bytes; SHA-256 "+backup.manifest.sha256);
    }finally{rmSync(temp,{recursive:true,force:true});}
   }else if(step.capability==="firmware.esp_idf.restore"){
    const temp=mkdtempSync(join(tmpdir(),"maincreate-esp-restore-"));
    try{
     const assets=await downloadJobArtifacts(config,job,temp);
     const image=assets.find(a=>a.name==="maincreate-esp32-backup.bin"),meta=assets.find(a=>a.name==="maincreate-esp32-backup.json");
     if(!image||!meta)throw new Error("Source backup job is missing firmware image or manifest");
     const manifest=JSON.parse(readFileSync(meta.path,"utf8"));
     const result=await restoreEsp32Firmware({port:job.parameters?.device_port,version:job.parameters?.toolkit_version,
      imagePath:image.path,manifest,deviceSerial:job.parameters?.device_serial});
     out.push(result.output);
    }finally{rmSync(temp,{recursive:true,force:true});}
   }else if(step.capability==="android.app.deploy"){
    const temp=mkdtempSync(join(tmpdir(),"maincreate-android-deploy-"));
    try{
     const assets=await downloadJobArtifacts(config,job,temp);
     const meta=assets.find(a=>a.name==="maincreate-android-manifest.json");
     if(!meta)throw new Error("Source Android build is missing its manifest");
     const manifest=JSON.parse(readFileSync(meta.path,"utf8"));
     const apk=assets.find(a=>a.mime==="application/vnd.android.package-archive");
     if(!apk)throw new Error("Source Android build has no APK artifact");
     const entry=manifest.outputs.find(x=>x.name===apk.name);
     if(!entry)throw new Error("APK is not listed in the Android build manifest");
     if(job.parameters?.package_name&&entry.packageName!==job.parameters.package_name)throw new Error("APK package does not match selected application");
     const result=await deployAndroidApk({adbPath:await localAdbPath(),serial:job.parameters?.device_serial,
      apkPath:apk.path,manifest,deviceProfile:job.parameters?.device_profile||"avalue-epd-42s"});
     out.push(result.output);
    }finally{rmSync(temp,{recursive:true,force:true});}
   }else if(step.capability==="android.app.backup"){
    const temp=mkdtempSync(join(tmpdir(),"maincreate-android-backup-"));
    try{
     const backup=await backupAndroidApk({adbPath:await localAdbPath(),serial:job.parameters?.device_serial,
      packageName:job.parameters?.package_name,outputDir:temp});
     for(const item of backup.outputs)ids.push(await uploadAsset(config,job.id,item.name,"application/vnd.android.package-archive",readFileSync(item.path)));
     ids.push(await uploadAsset(config,job.id,"maincreate-android-app-backup.json","application/json",readFileSync(backup.manifestPath)));
     out.push("Backed up "+backup.outputs.length+" APK package artifact(s) for "+job.parameters.package_name);
    }finally{rmSync(temp,{recursive:true,force:true});}
   }else if(step.capability==="android.app.restore"){
    const temp=mkdtempSync(join(tmpdir(),"maincreate-android-restore-"));
    try{
     const assets=await downloadJobArtifacts(config,job,temp);
     const meta=assets.find(a=>a.name==="maincreate-android-app-backup.json");
     if(!meta)throw new Error("Source Android backup is missing its manifest");
     const manifest=JSON.parse(readFileSync(meta.path,"utf8"));
     const apks=assets.filter(a=>a.mime==="application/vnd.android.package-archive").map(a=>a.path);
     const result=await restoreAndroidApk({adbPath:await localAdbPath(),serial:job.parameters?.device_serial,
      apkPaths:apks,manifest,packageName:job.parameters?.package_name});
     out.push(result.output);
    }finally{rmSync(temp,{recursive:true,force:true});}
   }else if(step.capability==="sdk.arduino_cli.install"){
    if(process.env.MAIN_RUNNER_ENABLE_SDK_INSTALLS!=="1")throw new Error("SDK installation adapter disabled by operator opt-in");
    const installed=await installArduinoCli({os,architecture:architecture});
    out.push("Installed "+installed.family+" "+installed.version+" for "+installed.target+"; verified "+installed.sha256);
   }else throw new Error("Runner does not support capability "+step.capability);
   results.push({capability:step.capability,status:"completed"});
  }catch(e){
   failed=true;out.push("Step "+step.capability+" failed: "+e.message);
   results.push({capability:step.capability,status:"failed"});
  }
 }
 const logs=out.join("\n").slice(-24000);
 await post("/api/agent/jobs/complete",{id:config.id,job_id:job.id,success:!failed,
  logs,steps:results,asset_ids:ids},config.token);
 console.log("Job "+job.id+" "+(failed?"failed":"completed")+"; artifacts "+ids.length);
}
function linuxSerialDevices(){
 const devices=[];
 let ports=[];try{ports=readdirSync("/sys/class/tty");}catch{return devices;}
 for(const name of ports){
  if(!/^tty(?:USB|ACM)\d+$/.test(name))continue;
  try{
   let current=realpathSync(join("/sys/class/tty",name,"device"));
   let vid=null,pid=null,serialNumber=null,manufacturer=null,product=null;
   for(let i=0;i<9&&current.startsWith("/sys/");i++){
    try{
     const v=readFileSync(join(current,"idVendor"),"utf8").trim();
     const p=readFileSync(join(current,"idProduct"),"utf8").trim();
     if(/^[a-f0-9]{4}$/i.test(v)&&/^[a-f0-9]{4}$/i.test(p)){
      vid=parseInt(v,16);pid=parseInt(p,16);
      const read=n=>{try{return readFileSync(join(current,n),"utf8").trim().slice(0,120);}catch{return null;}};
      serialNumber=read("serial");manufacturer=read("manufacturer");product=read("product");break;
     }
    }catch{}
    const next=dirname(current);if(next===current)break;current=next;
   }
   if(vid!==null&&pid!==null)devices.push({port:"/dev/"+name,description:product||name,
     manufacturer,product,vid,pid,serialNumber,location:null,interface:null});
  }catch{}
 }
 return devices.slice(0,48);
}
async function scanSerialDevices(){
 if(os==="linux")return linuxSerialDevices();
 const python=process.env.MAIN_RUNNER_PYTHON||(os==="windows"?"python":"python3");
 const script=fileURLToPath(new URL("./scan_devices.py",import.meta.url));
 return new Promise((resolve,reject)=>{
  const child=spawn(python,[script],{shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let raw="",errors="";
  const cap=buffer=>String(buffer).slice(0,1024);
  child.stdout.on("data",chunk=>{raw+=String(chunk);if(raw.length>64*1024)child.kill("SIGKILL");});
  child.stderr.on("data",chunk=>errors+=cap(chunk));
  const timeout=setTimeout(()=>child.kill("SIGKILL"),12000);
  child.once("error",e=>{clearTimeout(timeout);reject(e);});
  child.once("close",code=>{
   clearTimeout(timeout);
   if(code!==0)return reject(new Error("USB discovery unavailable: "+(errors||raw).slice(0,180)));
   try{
    const result=JSON.parse(raw);
    if(!Array.isArray(result.devices))throw new Error("Invalid inventory output");
    resolve(result.devices);
   }catch(e){reject(e);}
  });
 });
}
async function detectPackages(){
 const candidates=[["node","node",["--version"]],["git","git",["--version"]],
  ["python3","python3",["--version"]],["cmake","cmake",["--version"]],
  ["gcc","gcc",["--version"]],["esp-idf","idf.py",["--version"]],
  ["swift","swift",["--version"]],["xcode","xcodebuild",["-version"]]];
 const packages=[];
 for(const [name,bin,args] of candidates){
  try{
   const output=await new Promise((resolve,reject)=>{
    const child=spawn(bin,args,{shell:false,windowsHide:true,stdio:["ignore","pipe","ignore"]});
    let data="";const timer=setTimeout(()=>child.kill("SIGKILL"),3000);
    child.stdout.on("data",c=>{data+=String(c);if(data.length>2000)child.kill("SIGKILL");});
    child.once("error",e=>{clearTimeout(timer);reject(e);});
    child.once("close",code=>{clearTimeout(timer);code===0?resolve(data.trim()):reject(new Error("Tool unavailable"));});
   });
   packages.push({name,version:String(output.split(/\r?\n/)[0]||"installed").slice(0,90)});
 }catch{}
 }
 try{
  const cli=installedArduinoCli();
  const output=await new Promise((resolve,reject)=>{const child=spawn(cli,["version"],{shell:false,stdio:["ignore","pipe","ignore"]});let data="";const timer=setTimeout(()=>child.kill("SIGKILL"),3000);child.stdout.on("data",c=>data+=String(c));child.once("error",e=>{clearTimeout(timer);reject(e)});child.once("close",code=>{clearTimeout(timer);code===0&&isExactArduinoVersion(data)?resolve(data.trim()):reject(new Error("not exact Arduino CLI version"))})});
  packages.push({name:"arduino-cli",version:"1.5.1",path:cli,verified:true,source:"maincreate-per-user-sdk"});
 }catch{}
 return packages;
}
async function run(){
 const config=JSON.parse(readFileSync(path,"utf8"));
 if(config.url!==endpoint)throw new Error("Controller URL does not match enrollment");
 console.log("Runner started: "+config.name+"; approved jobs only, no shell/flash actions");
 const heartbeat=setInterval(()=>{
  post("/api/agent/heartbeat",{id:config.id},config.token).catch(e=>console.error("Heartbeat:",e.message));
 },30000);
 try{
  let nextScan=0,nextPackageScan=0;
  for(;;){
   if(Date.now()>=nextPackageScan){
    nextPackageScan=Date.now()+300000;
    try{await post("/api/agent/heartbeat",{id:config.id,packages:await detectPackages()},config.token);}
    catch(e){console.error("Package inventory:",e.message);}
   }
   if(process.env.MAIN_RUNNER_DEVICE_DISCOVERY!=="0"&&Date.now()>=nextScan){
    nextScan=Date.now()+60000;
    try{
     const devices=await scanSerialDevices();
     const summary=await post("/api/agent/devices",{id:config.id,devices},config.token);
     console.log("Device inventory: "+summary.seen+" USB serial device(s) on "+config.name);
    }catch(e){console.error("Device inventory skipped (previous inventory preserved):",e.message);}
   }
   try{
    const response=await post("/api/agent/jobs/claim",{id:config.id},config.token);
    if(response.job)await executeJob(config,response.job);
   }catch(e){console.error("Runner polling:",e.message);}
   await sleep(10000);
  }
 }finally{clearInterval(heartbeat);}
}
try{
 if(command==="enroll")await enroll();
 else if(command==="run")await run();
 else throw new Error("Usage: node agent.mjs enroll|run");
}catch(e){console.error("Runner error:",e.message);process.exitCode=1;}
