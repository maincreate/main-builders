import {createHash} from "node:crypto";
import {
  accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync
} from "node:fs";
import {promises as fs} from "node:fs";
import {join, dirname, resolve, relative, sep} from "node:path";
import {homedir, arch} from "node:os";
import {spawn} from "node:child_process";

export const EIM_RELEASE = Object.freeze({
  version:"0.21.1",
  source:"https://github.com/espressif/idf-im-ui/releases/tag/v0.21.1",
  targets:{
    "linux/x64":{
      artifact:"eim-cli-linux-x64-v0.21.1.zip",
      url:"https://github.com/espressif/idf-im-ui/releases/download/v0.21.1/eim-cli-linux-x64-v0.21.1.zip",
      sha256:"87a1d17c0208fe402269d39f471d862525ca902045b1a97f8af99902342fea8b"
    },
    "linux/arm64":{
      artifact:"eim-cli-linux-aarch64-v0.21.1.zip",
      url:"https://github.com/espressif/idf-im-ui/releases/download/v0.21.1/eim-cli-linux-aarch64-v0.21.1.zip",
      sha256:"dbb7db88869b985404757270c4b7e3a62a701759e0c224722a8cfa2414d08180"
    }
  }
});
export const ANDROID_SDK_RELEASE = Object.freeze({
  version:"2026.2.2-patch1",
  commandLineTools:"15859902",
  artifact:"commandlinetools-linux-15859902_latest.zip",
  url:"https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip",
  sha256:"4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583",
  platformTools:"37.0.1",
  buildTools:"36.0.0",
  platforms:["android-37","android-22"]
});
const BASE=join(homedir(),".local","share","maincreate","toolkits");
const safeVersion=v=>typeof v==="string"&&/^\d+\.\d+\.\d+$/.test(v);
const inside=(root,path)=>{const r=relative(resolve(root),resolve(path));return r!==""&&!r.startsWith(".."+sep)&&r!==".."&&!resolve(path).startsWith(sep+sep);};
const hash=data=>createHash("sha256").update(data).digest("hex");
const safePort=p=>typeof p==="string"&&(/^\/dev\/tty(?:USB|ACM)\d+$/.test(p)||/^\/dev\/serial\/by-id\/[A-Za-z0-9._-]+$/.test(p));
export const normalizeEspChip=s=>String(s||"").toLowerCase().replace(/[^a-z0-9]/g,"").replace(/^esp/,"");
export const validateSerialPort=s=>safePort(s);

export function toolkitRoot(base=BASE){if(typeof base!=="string"||!base)throw new Error("Invalid toolkit root");return resolve(base);}
export function idfVersionPath(version,root=toolkitRoot()){if(!safeVersion(version))throw new Error("Invalid ESP-IDF version");return join(root,"esp-idf",version);}
export function androidSdkPath(version=ANDROID_SDK_RELEASE.version,root=toolkitRoot()){
 if(!/^\d{4}\.\d+\.\d+-patch\d+$/.test(version))throw new Error("Invalid Android SDK version");
 return join(root,"android-sdk",version);
}
function run(bin,args,{cwd,env={},input,timeoutMs=120000,maxOutput=30000}={}){
 return new Promise((resolvePromise,reject)=>{
  const child=spawn(bin,args,{cwd,env:{...process.env,...env},shell:false,windowsHide:true,stdio:["pipe","pipe","pipe"]});
  let out="",err="",killed=false,settled=false;
  const capture=(which,chunk)=>{const value=String(chunk);if(which==="out")out=(out+value).slice(-maxOutput);else err=(err+value).slice(-maxOutput);};
  child.stdout.on("data",x=>capture("out",x));child.stderr.on("data",x=>capture("err",x));
  const timer=setTimeout(()=>{killed=true;child.kill("SIGKILL");},timeoutMs);
  const fail=e=>{if(settled)return;settled=true;clearTimeout(timer);reject(e);};
  child.once("error",fail);
  child.once("close",code=>{
   if(settled)return;settled=true;clearTimeout(timer);
   if(killed)return reject(new Error(bin+" timed out"));
   if(code!==0)return reject(new Error(bin+" exited "+code+": "+(err||out).slice(-5000)));
   resolvePromise({stdout:out,stderr:err,output:(out+"\n"+err).trim()});
  });
  if(input!==undefined)child.stdin.end(input);else child.stdin.end();
 });
}
async function downloadVerified(url,expectedSha,maxBytes=300*1024*1024){
 const allowed=new Set(["github.com","objects.githubusercontent.com","release-assets.githubusercontent.com","dl.google.com","redirector.gvt1.com"]);
 let current=new URL(url);
 for(let i=0;i<=4;i++){
  if(current.protocol!=="https:"||!allowed.has(current.hostname))throw new Error("Toolkit download host is not approved");
  const response=await fetch(current,{redirect:"manual",signal:AbortSignal.timeout(180000)});
  if(response.status>=300&&response.status<400){
   const location=response.headers.get("location");if(!location)throw new Error("Toolkit download redirect is missing");
   current=new URL(location,current);continue;
  }
  if(!response.ok)throw new Error("Toolkit download HTTP "+response.status);
  const length=Number(response.headers.get("content-length")||0);
  if(length>maxBytes)throw new Error("Toolkit archive exceeds size limit");
  const reader=response.body?.getReader();if(!reader)throw new Error("Toolkit download body unavailable");
  const chunks=[];let total=0;
  for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes)throw new Error("Toolkit archive exceeds size limit");chunks.push(Buffer.from(value));}
  const data=Buffer.concat(chunks,total);
  if(hash(data)!==expectedSha)throw new Error("Toolkit SHA-256 verification failed");
  return data;
 }
 throw new Error("Too many toolkit download redirects");
}
function findFiles(root,name,maxDepth=9,depth=0,out=[]){
 if(depth>maxDepth)return out;
 let entries;try{entries=readdirSync(root,{withFileTypes:true});}catch{return out;}
 for(const entry of entries){
  if(entry.name.startsWith("."))continue;
  const path=join(root,entry.name);
  if(entry.isFile()&&entry.name===name)out.push(path);
  else if(entry.isDirectory()&&!entry.isSymbolicLink())findFiles(path,name,maxDepth,depth+1,out);
 }
 return out;
}
async function extractZip(data,stage){
 const archive=join(stage,"archive.zip");
 writeFileSync(archive,data,{mode:0o600,flag:"wx"});
 const listing=await run("unzip",["-Z1",archive],{timeoutMs:30000,maxOutput:1000000});
 const names=listing.stdout.split(/\r?\n/).filter(Boolean);
 if(!names.length||names.length>50000)throw new Error("Toolkit archive has an invalid entry count");
 for(const name of names){
  if(name.startsWith("/")||name.includes("\\")||name.split("/").includes("..")||/^[A-Za-z]:/.test(name))
   throw new Error("Toolkit archive contains an unsafe path");
 }
 const out=join(stage,"extract");mkdirSync(out,{recursive:true,mode:0o700});
 await run("unzip",["-qq",archive,"-d",out],{timeoutMs:120000});
 return out;
}
function saveManifest(family,version,record,root=toolkitRoot()){
 const dir=join(root,"manifests");mkdirSync(dir,{recursive:true,mode:0o700});
 const path=join(dir,family+"-"+version+".json");
 writeFileSync(path,JSON.stringify({...record,family,version,verifiedAt:new Date().toISOString()},null,2)+"\n",{mode:0o600});
 return path;
}
function readManifest(family,version,root=toolkitRoot()){
 const path=join(root,"manifests",family+"-"+version+".json");
 if(!existsSync(path))throw new Error(family+" "+version+" is not installed by Main{Create}");
 const value=JSON.parse(readFileSync(path,"utf8"));
 if(value.family!==family||value.version!==version)throw new Error("Toolkit manifest identity mismatch");
 return value;
}
async function runIdf(activationScript,args,timeoutMs=30*60*1000){
 if(!activationScript||!existsSync(activationScript))throw new Error("ESP-IDF activation script is missing");
 const script='source "$1" >/dev/null 2>&1 && shift && idf.py "$@"';
 return run("bash",["-lc",script,"maincreate",activationScript,...args],{timeoutMs,maxOutput:60000});
}
export async function verifyEspIdf(version,{root=toolkitRoot()}={}){
 if(!safeVersion(version))throw new Error("Invalid ESP-IDF version");
 const record=readManifest("esp-idf",version,root);
 if(!inside(join(root,"esp-idf",version),record.activationScript)||!existsSync(record.activationScript))
  throw new Error("ESP-IDF activation script is missing or outside its version root");
 const result=await runIdf(record.activationScript,["--version"],30000);
 if(!new RegExp("\\bv?"+version.replace(/\./g,"\\.")+"\\b").test(result.output))
  throw new Error("Installed ESP-IDF does not match selected version "+version);
 return {...record,verified:true,versionOutput:result.output.slice(0,500)};
}
export async function installEspIdf({version,os="linux",architecture=arch(),root=toolkitRoot(),downloadFn=downloadVerified}={}){
 if(!["5.5.6","6.1.1"].includes(version))throw new Error("ESP-IDF version is not in the endorsed pilot catalog");
 const recipe=EIM_RELEASE.targets[os+"/"+architecture];
 if(!recipe)throw new Error("ESP-IDF EIM installer is not validated for "+os+"/"+architecture);
 try{return {...await verifyEspIdf(version,{root}),status:"already-installed"};}catch(e){if(!/not installed/.test(e.message))throw e;}
 const versionRoot=idfVersionPath(version,root),eimRoot=join(root,"eim",EIM_RELEASE.version,os+"-"+architecture);
 mkdirSync(eimRoot,{recursive:true,mode:0o700});
 const archive=await downloadFn(recipe.url,recipe.sha256);
 const stage=await fs.mkdtemp(join(eimRoot,".stage-"));
 try{
  const extracted=await extractZip(archive,stage);
  const candidates=findFiles(extracted,"eim");
  const binary=candidates.find(p=>!p.includes("uninstall")&&lstatSync(p).isFile());
  if(!binary)throw new Error("Espressif EIM archive does not contain the expected CLI binary");
  const eim=join(eimRoot,"eim");mkdirSync(dirname(eim),{recursive:true,mode:0o700});
  const staged=join(stage,"eim-cli");await fs.copyFile(binary,staged);chmodSync(staged,0o700);
  await run(staged,["--version"],{timeoutMs:15000});
  mkdirSync(versionRoot,{recursive:true,mode:0o700});
  await run(staged,["-n","true","-i","v"+version,"-p",versionRoot],{timeoutMs:90*60*1000,maxOutput:60000});
  const activations=findFiles(versionRoot,"activate_idf_v"+version+".sh");
  const exports=findFiles(versionRoot,"export.sh");
  const activationScript=activations[0]||exports[0]||null;
  if(!activationScript)throw new Error("EIM finished but no ESP-IDF activation script was found");
  const checked=await runIdf(activationScript,["--version"],30000);
  if(!new RegExp("\\\\bv?"+version.replace(/\./g,"\\\\.")+"\\\\b").test(checked.output))
   throw new Error("EIM installed a different ESP-IDF version than requested");
  const record={activationScript,eimPath:eim,eimVersion:EIM_RELEASE.version,installerSha256:recipe.sha256,versionOutput:checked.output};
  saveManifest("esp-idf",version,record,root);
  return {status:"installed",family:"esp-idf",version,activationScript,eimVersion:EIM_RELEASE.version,sha256:recipe.sha256};
 }finally{rmSync(stage,{recursive:true,force:true});}
}
export async function verifyAndroidSdk({version=ANDROID_SDK_RELEASE.version,root=toolkitRoot()}={}){
 const record=readManifest("android-sdk",version,root);
 if(!inside(androidSdkPath(version,root),record.sdkRoot))throw new Error("Android SDK root is outside its version scope");
 const sdkmanager=join(record.sdkRoot,"cmdline-tools",ANDROID_SDK_RELEASE.commandLineTools,"bin","sdkmanager");
 const adb=join(record.sdkRoot,"platform-tools","adb");
 const aapt=join(record.sdkRoot,"build-tools",ANDROID_SDK_RELEASE.buildTools,"aapt");
 for(const path of [sdkmanager,adb,aapt])if(!existsSync(path))throw new Error("Android SDK component is missing: "+path);
 const av=await run(adb,["version"],{timeoutMs:15000});
 if(!av.output.includes(ANDROID_SDK_RELEASE.platformTools))throw new Error("Android Platform-Tools version is not "+ANDROID_SDK_RELEASE.platformTools);
 return {...record,verified:true,adb,aapt,sdkmanager};
}
function javaHomeFromPath(path){
 const real=realpathSync(path);return dirname(dirname(real));
}
async function java17(){
 const candidates=[];
 if(process.env.JAVA_HOME)candidates.push(process.env.JAVA_HOME);
 const jvmRoot="/usr/lib/jvm";
 if(existsSync(jvmRoot)){
  for(const name of readdirSync(jvmRoot))if(/^java-17-openjdk/.test(name))candidates.push(join(jvmRoot,name));
 }
 for(const home of [...new Set(candidates)]){
  const java=join(home,"bin","java");if(!existsSync(java))continue;
  try{
   const result=await run(java,["-version"],{timeoutMs:10000});
   const match=result.output.match(/version "(d+)/)||result.output.match(/openjdk (d+)/i);
   if(match&&Number(match[1])===17)return home;
  }catch{}
 }
 throw new Error("Android SDK profile requires JDK 17 exactly. Install JDK 17 on this builder before installing the Android toolkit.");
}
export async function installAndroidSdk({version=ANDROID_SDK_RELEASE.version,os="linux",architecture=arch(),root=toolkitRoot(),downloadFn=downloadVerified}={}){
 if(version!==ANDROID_SDK_RELEASE.version)throw new Error("Android SDK version is not in the current endorsed catalog");
 if(os!=="linux"||architecture!=="x64")throw new Error("Google Android command-line tools are supported here only on Linux x64");
 try{return {...await verifyAndroidSdk({version,root}),status:"already-installed"};}catch(e){if(!/not installed/.test(e.message))throw e;}
 const sdkRoot=androidSdkPath(version,root);mkdirSync(sdkRoot,{recursive:true,mode:0o700});
 const javaHome=await java17();
 const archive=await downloadFn(ANDROID_SDK_RELEASE.url,ANDROID_SDK_RELEASE.sha256);
 const stage=await fs.mkdtemp(join(sdkRoot,".stage-"));
 try{
  const extracted=await extractZip(archive,stage);
  const cliRoot=join(extracted,"cmdline-tools");
  if(!existsSync(join(cliRoot,"bin","sdkmanager")))throw new Error("Android command-line tools archive layout is invalid");
  const dest=join(sdkRoot,"cmdline-tools",ANDROID_SDK_RELEASE.commandLineTools);
  mkdirSync(dirname(dest),{recursive:true,mode:0o700});
  if(existsSync(dest))rmSync(dest,{recursive:true,force:true});
  await fs.rename(cliRoot,dest);
  const sdkmanager=join(dest,"bin","sdkmanager"),env={JAVA_HOME,ANDROID_HOME:sdkRoot,ANDROID_SDK_ROOT:sdkRoot};
  const licenses="y\n".repeat(40);
  await run(sdkmanager,["--sdk_root="+sdkRoot,"--licenses"],{env,input:licenses,timeoutMs:180000,maxOutput:30000});
  await run(sdkmanager,["--sdk_root="+sdkRoot,"platform-tools","platforms;android-37","platforms;android-22","build-tools;36.0.0"],{env,input:licenses,timeoutMs:45*60*1000,maxOutput:60000});
  const record={sdkRoot,javaHome,commandLineTools:ANDROID_SDK_RELEASE.commandLineTools,
   platformTools:ANDROID_SDK_RELEASE.platformTools,buildTools:ANDROID_SDK_RELEASE.buildTools,
   platforms:ANDROID_SDK_RELEASE.platforms,installerSha256:ANDROID_SDK_RELEASE.sha256};
  saveManifest("android-sdk",version,record,root);
  return {status:"installed",family:"android-sdk",version,sdkRoot,javaHome,platformTools:ANDROID_SDK_RELEASE.platformTools};
 }finally{rmSync(stage,{recursive:true,force:true});}
}
export async function installAndroidAdb({os="linux",architecture=arch(),root=toolkitRoot()}={}){
 if(os!=="linux"||!["arm64","x64"].includes(architecture))throw new Error("Android ADB device adapter supports Linux ARM64 and x64 only");
 const system=await run("sh",["-lc","command -v adb || true"],{timeoutMs:5000}).catch(()=>({stdout:""}));
 if(system.stdout.trim()){
  const path=system.stdout.trim(),version=await run(path,["version"],{timeoutMs:15000});
  const record={adbPath:path,source:"system-package",versionOutput:version.output};
  saveManifest("android-adb","system",record,root);
  return {status:"verified",family:"android-adb",version:"system",adbPath:path};
 }
 const packageRoot=join(root,"android-adb","system",architecture);
 mkdirSync(packageRoot,{recursive:true,mode:0o700});
 const stage=await fs.mkdtemp(join(packageRoot,".stage-"));
 try{
  await run("apt-get",["download","adb"],{cwd:stage,timeoutMs:180000,maxOutput:20000});
  const debs=readdirSync(stage).filter(n=>/^adb_.*\\.deb$/.test(n));
  if(debs.length!==1)throw new Error("Debian apt did not provide exactly one ADB package");
  const extracted=join(stage,"extract");mkdirSync(extracted,{mode:0o700});
  await run("dpkg-deb",["-x",join(stage,debs[0]),extracted],{timeoutMs:30000});
  const candidates=findFiles(extracted,"adb");
  const binary=candidates.find(p=>p.endsWith("/usr/bin/adb"));
  if(!binary)throw new Error("Debian ADB package did not contain /usr/bin/adb");
  const dest=join(packageRoot,"adb");await fs.copyFile(binary,dest);chmodSync(dest,0o700);
  const linked=await run("ldd",[dest],{timeoutMs:10000});
  if(linked.output.includes("not found"))throw new Error("Debian ADB package has missing runtime libraries: "+linked.output.slice(-1000));
  const version=await run(dest,["version"],{timeoutMs:15000});
  const record={adbPath:dest,source:"debian-signed-apt-package",packageFile:debs[0],versionOutput:version.output};
  saveManifest("android-adb","system",record,root);
  return {status:"installed",family:"android-adb",version:"system",adbPath:dest,package:debs[0]};
 }finally{rmSync(stage,{recursive:true,force:true});}
}
export async function verifyAndroidAdb({root=toolkitRoot()}={}){
 const record=readManifest("android-adb","system",root);
 if(!existsSync(record.adbPath))throw new Error("Android ADB executable is missing");
 const version=await run(record.adbPath,["version"],{timeoutMs:15000});
 return {...record,verified:true,versionOutput:version.output};
}
export async function buildEspIdfProject({projectDir,version,root=toolkitRoot()}={}){
 const installed=await verifyEspIdf(version,{root});
 await runIdf(installed.activationScript,["-C",projectDir,"build"],30*60*1000);
 const merged=join(projectDir,"build","maincreate-firmware.bin");
 await runIdf(installed.activationScript,["-C",projectDir,"merge-bin","-o",merged,"-f","raw"],15*60*1000);
 if(!existsSync(merged)||statSync(merged).size<1||statSync(merged).size>8*1024*1024)throw new Error("Merged ESP32 firmware image is missing or outside artifact limits");
 const image=readFileSync(merged),config=existsSync(join(projectDir,"sdkconfig"))?readFileSync(join(projectDir,"sdkconfig"),"utf8"):"";
 const target=config.match(/^CONFIG_IDF_TARGET="([^"]+)"/m)?.[1]||"unknown";
 const manifest={schema:1,artifactType:"esp32-firmware-image",toolkit:"esp-idf",version,
  target,sourceRevision:null,imageName:"maincreate-firmware.bin",sha256:hash(image),size:image.length,
  flashOffset:"0x0",createdAt:new Date().toISOString()};
 const manifestPath=join(projectDir,"build","maincreate-firmware-manifest.json");
 writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n",{mode:0o600});
 return {imagePath:merged,manifestPath,manifest,log:"ESP-IDF "+version+" build and merge completed"};
}
export async function buildAndroidApp({projectDir,version=ANDROID_SDK_RELEASE.version,targetProfile,root=toolkitRoot()}={}){
 const sdk=await verifyAndroidSdk({version,root});
 const wrapper=join(projectDir,process.platform==="win32"?"gradlew.bat":"gradlew");
 if(!existsSync(wrapper))throw new Error("Android project Gradle Wrapper is required");
 const gradleArgs=["--no-daemon","--stacktrace","assembleDebug"];
 await run(wrapper,gradleArgs,{cwd:projectDir,env:{JAVA_HOME:sdk.javaHome,ANDROID_HOME:sdk.sdkRoot,ANDROID_SDK_ROOT:sdk.sdkRoot,
  PATH:join(sdk.javaHome,"bin")+":"+process.env.PATH},timeoutMs:45*60*1000,maxOutput:60000});
 const apks=[];
 const search=(dir,depth=0)=>{if(depth>7)return;let entries;try{entries=readdirSync(dir,{withFileTypes:true});}catch{return;}
  for(const e of entries){const p=join(dir,e.name);if(e.isDirectory()&&!e.isSymbolicLink())search(p,depth+1);
   else if(e.isFile()&&e.name.endsWith(".apk")&&!/androidTest|test/i.test(p))apks.push(p);}};
 search(join(projectDir,"app","build","outputs","apk"));
 if(!apks.length)throw new Error("Android Gradle build completed but produced no installable APK");
 if(apks.length>5)throw new Error("Android project produced too many APK outputs for this pilot");
 const profile=targetProfile||"android-current-api37",legacy=profile==="android-legacy-api22-eink";
 const records=[];
 for(const apk of apks){
  const badging=await run(join(sdk.sdkRoot,"build-tools",ANDROID_SDK_RELEASE.buildTools,"aapt"),["dump","badging",apk],{timeoutMs:30000});
  const packageName=badging.output.match(/^package: name='([^']+)'/m)?.[1];
  const minSdk=Number(badging.output.match(/sdkVersion:'(\d+)'/)?.[1]||0);
  const targetSdk=Number(badging.output.match(/targetSdkVersion:'(\d+)'/)?.[1]||0);
  if(!packageName||!minSdk||!targetSdk)throw new Error("Could not read Android APK package/API metadata");
  if(legacy&&(minSdk>22||targetSdk>22))throw new Error("Legacy E Ink APK must declare minSdk and targetSdk no higher than API 22");
  const zip=await run("unzip",["-Z1",apk],{timeoutMs:30000,maxOutput:1000000});
  const abis=[...new Set([...zip.stdout.matchAll(/^lib\/([^/]+)\//gm)].map(x=>x[1]))];
  if(legacy&&abis.length&&!abis.includes("armeabi-v7a"))throw new Error("Legacy E Ink APK native libraries must include armeabi-v7a");
  const bytes=readFileSync(apk);
  records.push({path:apk,name:apk.split(/[\\/]/).at(-1),packageName,minSdk,targetSdk,abis,sha256:hash(bytes),size:bytes.length});
 }
 const manifest={schema:1,artifactType:"android-apk",toolkit:"android-sdk",version,targetProfile,outputs:records,createdAt:new Date().toISOString()};
 const manifestPath=join(projectDir,"app","build","outputs","maincreate-android-manifest.json");
 writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n",{mode:0o600});
 return {apks:records,manifestPath,manifest,log:"Android APK build and metadata validation completed"};
}
async function esptool(activationScript,args,timeoutMs=180000){
 const script='source "$1" >/dev/null 2>&1 && shift && python -m esptool "$@"';
 return run("bash",["-lc",script,"maincreate",activationScript,...args],{timeoutMs,maxOutput:30000});
}
export async function probeEsp32({port,version="6.1.1",root=toolkitRoot()}={}){
 if(!safePort(port))throw new Error("Unsafe or unsupported ESP32 serial port");
 const installed=await verifyEspIdf(version,{root});
 try{
  const result=await esptool(installed.activationScript,["--port",port,"chip-id"],45000);
  const chip=result.output.match(/(?:Chip is|Chip type:|Detecting chip type\.\.\.\s*)(ESP32(?:-[A-Z0-9]+)?)/i)?.[1];
  if(!chip)throw new Error("esptool did not report a recognized chip identity");
  return {chip:chip.toUpperCase(),output:result.output};
 }catch(first){
  const result=await esptool(installed.activationScript,["--port",port,"chip_id"],45000);
  const chip=result.output.match(/(?:Chip is|Chip type:|Detecting chip type\.\.\.\s*)(ESP32(?:-[A-Z0-9]+)?)/i)?.[1];
  if(!chip)throw first;
  return {chip:chip.toUpperCase(),output:result.output};
 }
}
export async function flashEsp32({port,version="6.1.1",imagePath,manifest,root=toolkitRoot()}={}){
 if(!existsSync(imagePath)||!manifest||manifest.artifactType!=="esp32-firmware-image")throw new Error("Verified ESP32 firmware artifact is required");
 const actualHash=hash(readFileSync(imagePath));if(actualHash!==manifest.sha256)throw new Error("ESP32 firmware artifact checksum mismatch");
 const probe=await probeEsp32({port,version,root});
 if(normalizeEspChip(probe.chip)!==normalizeEspChip(manifest.target))throw new Error("Connected chip "+probe.chip+" does not match firmware target "+manifest.target);
 const installed=await verifyEspIdf(version,{root});
 try{return await esptool(installed.activationScript,["--port",port,"write-flash","0x0",imagePath],180000);}
 catch(first){try{return await esptool(installed.activationScript,["--port",port,"write_flash","0x0",imagePath],180000);}catch{throw first;}}
}
export async function backupEsp32Firmware({port,version="6.1.1",outputPath,deviceSerial,root=toolkitRoot()}={}){
 if(!safePort(port)||typeof deviceSerial!=="string"||!deviceSerial)throw new Error("Stable device serial and serial port are required");
 const probe=await probeEsp32({port,version,root}),installed=await verifyEspIdf(version,{root});
 let info;
 try{info=await esptool(installed.activationScript,["--port",port,"flash-id"],45000);}
 catch{info=await esptool(installed.activationScript,["--port",port,"flash_id"],45000);}
 const sizeMatch=info.output.match(/Detected flash size:\s*(\d+)\s*(KB|MB)/i);
 if(!sizeMatch)throw new Error("Could not determine flash size; refusing an unbounded flash readback");
 const flashBytes=Number(sizeMatch[1])*(sizeMatch[2].toUpperCase()==="MB"?1024*1024:1024);
 if(!Number.isSafeInteger(flashBytes)||flashBytes<1024*1024||flashBytes>64*1024*1024)throw new Error("Detected flash size is outside safe backup bounds");
 let security;
 try{security=await esptool(installed.activationScript,["--port",port,"get-security-info"],45000);}
 catch{try{security=await esptool(installed.activationScript,["--port",port,"get_security_info"],45000);}catch{throw new Error("ESP32 security state could not be verified; firmware readback backup is disabled");}}
 if(!/Secure Boot:\s*Disabled/i.test(security.output)||!/Flash Encryption:\s*Disabled/i.test(security.output))
  throw new Error("ESP32 secure boot or flash encryption is enabled/unknown; raw firmware backup is not safely restorable");
 try{await esptool(installed.activationScript,["--port",port,"read-flash","0x0",String(flashBytes),outputPath],180000);}
 catch(first){try{await esptool(installed.activationScript,["--port",port,"read_flash","0x0",String(flashBytes),outputPath],180000);}catch{throw first;}}
 const image=readFileSync(outputPath),manifest={schema:1,artifactType:"esp32-firmware-backup",
  chip:probe.chip,deviceSerial,flashBytes,sha256:hash(image),size:image.length,
  securityProbe:"completed",createdAt:new Date().toISOString()};
 const manifestPath=outputPath+".json";writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n",{mode:0o600});
 return {imagePath:outputPath,manifestPath,manifest};
}
export async function restoreEsp32Firmware({port,version="6.1.1",imagePath,manifest,deviceSerial,root=toolkitRoot()}={}){
 if(!manifest||manifest.artifactType!=="esp32-firmware-backup"||manifest.deviceSerial!==deviceSerial)
  throw new Error("Firmware restore is restricted to the original device serial");
 if(hash(readFileSync(imagePath))!==manifest.sha256)throw new Error("Firmware backup checksum mismatch");
 const probe=await probeEsp32({port,version,root});
 if(normChip(probe.chip)!==normChip(manifest.chip))throw new Error("Backup chip identity does not match connected device");
 const installed=await verifyEspIdf(version,{root});
 let info;
 try{info=await esptool(installed.activationScript,["--port",port,"flash-id"],45000);}
 catch{info=await esptool(installed.activationScript,["--port",port,"flash_id"],45000);}
 const sizeMatch=info.output.match(/Detected flash size:\s*(\d+)\s*(KB|MB)/i);
 if(!sizeMatch)throw new Error("Could not verify target flash size");
 const size=Number(sizeMatch[1])*(sizeMatch[2].toUpperCase()==="MB"?1024*1024:1024);
 if(size!==manifest.flashBytes)throw new Error("Backup flash size does not match connected device");
 try{return await esptool(installed.activationScript,["--port",port,"write-flash","0x0",imagePath],180000);}
 catch(first){try{return await esptool(installed.activationScript,["--port",port,"write_flash","0x0",imagePath],180000);}catch{throw first;}}
}
export async function deployAndroidApk({adbPath,serial,apkPath,manifest,deviceProfile="avalue-epd-42s"}={}){
 if(typeof adbPath!=="string"||!existsSync(adbPath)||typeof serial!=="string"||!serial||!existsSync(apkPath))throw new Error("ADB, authorized device serial and APK are required");
 if(!manifest||manifest.artifactType!=="android-apk"||!Array.isArray(manifest.outputs))throw new Error("Verified Android APK manifest is required");
 const entry=manifest.outputs.find(x=>x.name===apkPath.split(/[\\/]/).at(-1));
 if(!entry||hash(readFileSync(apkPath))!==entry.sha256)throw new Error("Android APK checksum does not match build manifest");
 const state=await run(adbPath,["-s",serial,"get-state"],{timeoutMs:15000});
 if(!state.stdout.includes("device"))throw new Error("Android device is not authorized or online");
 const api=Number((await run(adbPath,["-s",serial,"shell","getprop","ro.build.version.sdk"],{timeoutMs:15000})).stdout.trim());
 const abi=(await run(adbPath,["-s",serial,"shell","getprop","ro.product.cpu.abi"],{timeoutMs:15000})).stdout.trim();
 const product=(await run(adbPath,["-s",serial,"shell","getprop","ro.build.product"],{timeoutMs:15000})).stdout.trim();
 if(deviceProfile==="avalue-epd-42s"&&(api!==22||abi!=="armeabi-v7a"||!/^sabresd_7d_eink$/i.test(product)))
  throw new Error("Connected Android device does not match the Avalue EPD-42S API 22 / ARMv7 profile");
 if(entry.minSdk>api)throw new Error("APK minimum API exceeds connected Android device API");
 if(entry.abis.length&&!entry.abis.includes(abi))throw new Error("APK has no native library for connected device ABI");
 return run(adbPath,["-s",serial,"install","-r",apkPath],{timeoutMs:180000,maxOutput:20000});
}
export async function backupAndroidApk({adbPath,serial,packageName,outputDir}={}){
 if(!adbPath||!serial||!/^([A-Za-z][A-Za-z0-9_]*\.)+[A-Za-z][A-Za-z0-9_]*$/.test(packageName||""))throw new Error("ADB device and valid Android package name are required");
 const state=await run(adbPath,["-s",serial,"get-state"],{timeoutMs:15000});
 if(!state.stdout.includes("device"))throw new Error("Android device is not authorized or online");
 mkdirSync(outputDir,{recursive:true,mode:0o700});
 const paths=(await run(adbPath,["-s",serial,"shell","pm","path",packageName],{timeoutMs:15000})).stdout.split(/\r?\n/).map(x=>x.replace(/^package:/,"").trim()).filter(x=>x.startsWith("/"));
 if(!paths.length||paths.length>20)throw new Error("Android package manager did not return a bounded APK path list");
 const outputs=[];
 for(let i=0;i<paths.length;i++){
  const name=(i===0?"base":"split-"+i)+".apk",dest=join(outputDir,name);
  await run(adbPath,["-s",serial,"pull",paths[i],dest],{timeoutMs:120000});
  const bytes=readFileSync(dest);outputs.push({name,path:dest,sha256:hash(bytes),size:bytes.length});
 }
 const manifest={schema:1,artifactType:"android-app-backup",packageName,deviceSerial:serial,outputs,createdAt:new Date().toISOString()};
 const manifestPath=join(outputDir,"android-app-backup.json");writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+"\n",{mode:0o600});
 return {outputs,manifest,manifestPath};
}
export async function restoreAndroidApk({adbPath,serial,apkPaths,manifest,packageName}={}){
 if(!manifest||manifest.artifactType!=="android-app-backup"||manifest.deviceSerial!==serial||manifest.packageName!==packageName)
  throw new Error("Android app restore requires the original device serial and package identity");
 if(!Array.isArray(apkPaths)||!apkPaths.length||apkPaths.length!==manifest.outputs?.length)
  throw new Error("Android backup is missing one or more APK splits");
 for(const path of apkPaths){const item=manifest.outputs.find(x=>x.name===path.split(/[\\/]/).at(-1));
  if(!item||hash(readFileSync(path))!==item.sha256)throw new Error("Android app backup checksum mismatch");}
 const args=apkPaths.length===1?["-s",serial,"install","-r",apkPaths[0]]:["-s",serial,"install-multiple","-r",...apkPaths];
 return run(adbPath,args,{timeoutMs:180000});
}
export function removeToolkit({family,version,root=toolkitRoot(),dryRun=true}={}){
 const paths=[];
 if(family==="esp-idf"&&safeVersion(version))paths.push(idfVersionPath(version,root));
 else if(family==="android-sdk"&&version===ANDROID_SDK_RELEASE.version)paths.push(androidSdkPath(version,root));
 else if(family==="android-adb"&&version==="system")paths.push(join(root,"android-adb","system"));
 else if(family==="arduino-cli"&&version==="1.5.1")paths.push(join(root,"arduino-cli","1.5.1"));
 else throw new Error("Toolkit cleanup target is not allowlisted");
 for(const path of paths)if(existsSync(path)&&(!inside(root,path)||!inside(root,realpathSync(path))))throw new Error("Cleanup target escaped the managed toolkit root");
 if(dryRun)return {status:"dry-run",family,version,paths:paths.filter(existsSync)};
 for(const path of paths)if(existsSync(path))rmSync(path,{recursive:true,force:true});
 const manifest=join(root,"manifests",family+"-"+version+".json");
 if(existsSync(manifest))rmSync(manifest,{force:true});
 return {status:"removed",family,version,paths};
}
