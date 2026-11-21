package main

// Staged, deliberately UNREGISTERED flash adapter.
// It cannot be invoked by a Fabric job until the controller/Host capability
// and explicit administrator approval path have completed review.
import (
 "context"
 "errors"
 "fmt"
 "os"
 "path/filepath"
 "runtime"
 "strings"
 "time"
)

func approvedPlainESP32Security(output string)bool{
 // Fail closed until we have reviewed the exact live esptool format. Merely
 // receiving a successful get_security_info response never grants write access.
 text:=strings.ToLower(output)
 return strings.Count(text,"flash encryption: disabled")==1&&
  strings.Count(text,"secure boot: disabled")==1&&
  !strings.Contains(text,"flash encryption: enabled")&&
  !strings.Contains(text,"secure boot: enabled")
}

func verifyESP32WriteSecurity(port,expectedMAC string)error{
 if _,err:=verifiedESP32Identity(port,expectedMAC);err!=nil{return err}
 home:=espRuntimeHome()
 ctx,cancel:=context.WithTimeout(context.Background(),60*time.Second);defer cancel()
 out,err:=runBoundedCommand(ctx,home,home,eimBinaryPath(runtime.GOARCH),
  "--do-not-track","true","run",
  "python -m esptool --port "+port+" get_security_info","v"+espBackupVersion)
 if err!=nil{return err}
 if !approvedPlainESP32Security(out){
  return errors.New("ESP32 security state is not explicitly verified safe for plaintext flashing")
 }
 return nil
}

func flashESP32Guarded(c config,jobID,port,expectedMAC,sourceJobID string)(string,error){
 if runtime.GOOS!="linux"{return "",errors.New("managed flash requires Linux")}
 if !smokeJobPattern.MatchString(jobID)||!smokeJobPattern.MatchString(sourceJobID){
  return "",errors.New("invalid immutable firmware job identity")
 }
 if !exactMACPattern.MatchString(expectedMAC){return "",errors.New("canonical expected MAC required")}
 if err:=validateESP32Port(port);err!=nil{return "",err}
 // Verify uploaded source and its immutable build manifest BEFORE touching
 // the device. No caller-provided URL, image path, layout or shell command.
 images,err:=fetchVerifiedFlashBundle(c,jobID,sourceJobID)
 if err!=nil{return "",fmt.Errorf("source bundle rejected: %w",err)}
 dir:=filepath.Join(dataDir,"flash-jobs",jobID)
 if err:=os.MkdirAll(dir,0700);err!=nil{return "",err}
 defer os.RemoveAll(dir)
 staged:=map[string]string{}
 for _,name:=range flashArtifactNames{
  path:=filepath.Join(dir,name)
  if err:=os.WriteFile(path,images[name],0600);err!=nil{return "",err}
  staged[name]=path
 }
 if err:=verifyESP32WriteSecurity(port,expectedMAC);err!=nil{return "",err}
 // Hard stop on unsuccessful or truncated backup upload: never write unless
 // the 16 MiB backup and all SHA-256 checked parts have reached controller.
 if _,err:=backupESP32Managed(c,jobID,port,expectedMAC);err!=nil{
  return "",fmt.Errorf("required full-device backup failed; no firmware written: %w",err)
 }
 // Revalidate physical identity and security after the backup and
 // immediately before first write; the fixed MAC binds a USB port to a chip.
 if err:=verifyESP32WriteSecurity(port,expectedMAC);err!=nil{return "",err}
 home:=espRuntimeHome()
 eim:=eimBinaryPath(runtime.GOARCH)
 ctx,cancel:=context.WithTimeout(context.Background(),12*time.Minute);defer cancel()
 pairs:=" 0x0 "+staged["esp32s3-bootloader.bin"]+
  " 0x8000 "+staged["esp32s3-partitions.bin"]+
  " 0x10000 "+staged["esp32s3-firmware.bin"]
 args:=[]string{"--do-not-track","true","run",
  "python -m esptool --port "+port+" --baud "+backupSerialBaud+
   " write_flash --flash_size detect"+pairs,"v"+espBackupVersion}
 if _,err:=runBoundedCommand(ctx,home,home,eim,args...);err!=nil{
  return "",fmt.Errorf("ESP32 write failed; recover using the verified backup: %w",err)
 }
 if _,err:=runBoundedCommand(ctx,home,home,eim,"--do-not-track","true","run",
  "python -m esptool --port "+port+" --baud "+backupSerialBaud+
   " verify_flash"+pairs,"v"+espBackupVersion);err!=nil{
  return "",fmt.Errorf("ESP32 post-write byte verification failed; recovery image retained: %w",err)
 }
 if _,err:=verifiedESP32Identity(port,expectedMAC);err!=nil{
  return "",fmt.Errorf("ESP32 post-write identity not verified: %w",err)
 }
 return "ESP32-S3 firmware flashed and byte-verified against immutable source; full-device recovery backup preserved",nil
}
