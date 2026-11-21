package main

import (
 "crypto/sha256"
 "encoding/hex"
 "encoding/json"
 "testing"
)

func TestFlashBundleRejectsUnreviewedOrModifiedFirmware(t *testing.T){
 sourceID:="0123456789abcdef0123456789abcdef"
 images:=map[string][]byte{}
 manifest:=flashSourceManifest{Schema:1,JobID:sourceID,Framework:"esp-idf",FrameworkVersion:"5.5.6",
  Target:"esp32s3",SourceSHA256:"a"+string(make([]byte,0))}
 manifest.SourceSHA256="a" // replaced with 64-character digest below
 for len(manifest.SourceSHA256)<64{manifest.SourceSHA256+="a"}
 for i,name:=range flashArtifactNames{
  data:=make([]byte,1024+i*64);for j:=range data{data[j]=byte(i+j)}
  images[name]=data
  hash:=sha256.Sum256(data)
  manifest.Files=append(manifest.Files,flashManifestFile{Name:name,Size:len(data),SHA256:hex.EncodeToString(hash[:])})
 }
 encoded,_:=json.Marshal(manifest)
 if err:=verifyFlashSourceBundle(sourceID,encoded,images);err!=nil{t.Fatal(err)}
 if err:=verifyFlashSourceBundle("f"+sourceID[1:],encoded,images);err==nil{t.Fatal("source job ID must match")}
 images["esp32s3-firmware.bin"][7]^=0xff
 if err:=verifyFlashSourceBundle(sourceID,encoded,images);err==nil{t.Fatal("modified firmware accepted")}
 images["esp32s3-firmware.bin"][7]^=0xff
 manifest.Files[0].Name="../bootloader.bin"
 encoded,_=json.Marshal(manifest)
 if err:=verifyFlashSourceBundle(sourceID,encoded,images);err==nil{t.Fatal("unknown source name accepted")}
}
