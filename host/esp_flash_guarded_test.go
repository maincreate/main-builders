package main

import ("strings";"testing")

func TestESP32SecurityStateFailsClosed(t *testing.T){
 for _,input:=range []string{
  "Security Information",
  "Secure Boot: Enabled\nFlash Encryption: Disabled",
  "Secure Boot: Disabled\nFlash Encryption: Enabled",
  "Secure Boot: Disabled\nFlash Encryption: Disabled\nFlash Encryption: Disabled",
  "Secure Boot: Disabled",
  "",
 }{
  if approvedPlainESP32Security(input){t.Fatalf("unsafe or ambiguous security accepted: %q",input)}
 }
 if !approvedPlainESP32Security("Security Information:\nFlash Encryption: Disabled\nSecure Boot: Disabled"){
  t.Fatal("known explicitly disabled security should pass review")
 }
}
func TestFlashRejectsInvalidJobAndPortBeforeAssetDownload(t *testing.T){
 _,err:=flashESP32Guarded(config{},"../bad","/dev/ttyACM0","44:bd:8d:78:15:e8",strings.Repeat("f",32))
 if err==nil||!strings.Contains(err.Error(),"job identity"){t.Fatalf("unsafe job accepted: %v",err)}
 _,err=flashESP32Guarded(config{},strings.Repeat("a",32),"/dev/ttyACM0;sh","44:bd:8d:78:15:e8",strings.Repeat("f",32))
 if err==nil||!strings.Contains(err.Error(),"canonical"){t.Fatalf("unsafe serial path accepted: %v",err)}
}
