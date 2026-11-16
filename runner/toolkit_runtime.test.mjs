import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,symlinkSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
 EIM_RELEASE,ANDROID_SDK_RELEASE,idfVersionPath,androidSdkPath,
 normalizeEspChip,validateSerialPort,installEspIdf,installAndroidSdk,removeToolkit
} from "./toolkit_runtime.mjs";

test("EIM and Android command-line tool installers are pinned",()=>{
 assert.equal(EIM_RELEASE.version,"0.21.1");
 assert.equal(EIM_RELEASE.targets["linux/x64"].sha256.length,64);
 assert.equal(EIM_RELEASE.targets["linux/arm64"].sha256.length,64);
 assert.equal(ANDROID_SDK_RELEASE.commandLineTools,"15859902");
 assert.equal(ANDROID_SDK_RELEASE.platformTools,"37.0.1");
 assert.equal(ANDROID_SDK_RELEASE.sha256.length,64);
});

test("toolkit paths are version-scoped and reject traversal",()=>{
 const root="/tmp/maincreate-toolkit-test";
 assert.equal(idfVersionPath("6.1.1",root),join(root,"esp-idf","6.1.1"));
 assert.equal(androidSdkPath("2026.2.2-patch1",root),join(root,"android-sdk","2026.2.2-patch1"));
 assert.throws(()=>idfVersionPath("../escape",root),/version/);
 assert.throws(()=>androidSdkPath("../../escape",root),/version/);
});

test("ESP chip identity normalization and serial-port validation are strict",()=>{
 assert.equal(normalizeEspChip("ESP32-S3"),"32s3");
 assert.equal(normalizeEspChip("esp32c6"),"32c6");
 assert.equal(validateSerialPort("/dev/ttyUSB0"),true);
 assert.equal(validateSerialPort("/dev/ttyACM12"),true);
 assert.equal(validateSerialPort("/dev/serial/by-id/usb-Espressif_ABC"),true);
 assert.equal(validateSerialPort("/dev/../../etc/passwd"),false);
 assert.equal(validateSerialPort("COM3"),false);
});

test("ESP-IDF installer rejects unvalidated versions and hosts before download",async()=>{
 let downloads=0;
 const downloadFn=async()=>{downloads++;return Buffer.from("unused")};
 await assert.rejects(()=>installEspIdf({version:"6.2.0",os:"linux",architecture:"x64",root:"/tmp/x",downloadFn}),/not in the endorsed pilot catalog/);
 await assert.rejects(()=>installEspIdf({version:"6.1.1",os:"windows",architecture:"x64",root:"/tmp/x",downloadFn}),/not validated/);
 assert.equal(downloads,0);
});

test("Android SDK installer rejects Linux ARM64 before download",async()=>{
 let downloads=0;
 await assert.rejects(()=>installAndroidSdk({os:"linux",architecture:"arm64",root:"/tmp/x",
  downloadFn:async()=>{downloads++;return Buffer.from("unused")}}),/only on Linux x64/);
 assert.equal(downloads,0);
});

test("version cleanup is scoped, previewable and preserves other versions and projects",()=>{
 const root=mkdtempSync(join(tmpdir(),"maincreate-cleanup-"));
 try{
  const selected=idfVersionPath("5.5.6",root),other=idfVersionPath("6.1.1",root);
  const project=join(root,"projects","firmware");
  mkdirSync(selected,{recursive:true});mkdirSync(other,{recursive:true});mkdirSync(project,{recursive:true});
  writeFileSync(join(selected,"export.sh"),"");
  writeFileSync(join(other,"export.sh"),"");
  writeFileSync(join(project,"main.c"),"");
  const preview=removeToolkit({family:"esp-idf",version:"5.5.6",root,dryRun:true});
  assert.equal(preview.status,"dry-run");
  assert.equal(existsSync(selected),true);
  const result=removeToolkit({family:"esp-idf",version:"5.5.6",root,dryRun:false});
  assert.equal(result.status,"removed");
  assert.equal(existsSync(selected),false);
  assert.equal(existsSync(other),true);
  assert.equal(existsSync(project),true);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("cleanup refuses symlinks escaping the managed toolkit root",()=>{
 const root=mkdtempSync(join(tmpdir(),"maincreate-cleanup-link-"));
 const outside=mkdtempSync(join(tmpdir(),"maincreate-outside-"));
 try{
  const target=idfVersionPath("5.5.6",root);
  mkdirSync(join(root,"esp-idf"),{recursive:true});
  symlinkSync(outside,target,"dir");
  assert.throws(()=>removeToolkit({family:"esp-idf",version:"5.5.6",root,dryRun:false}),/escaped/);
  assert.equal(existsSync(outside),true);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
