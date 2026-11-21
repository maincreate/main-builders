package main

import (
 "archive/zip"
 "bytes"
 "context"
 "fmt"
 "net/http"
 "testing"
 "time"
)
// Diagnostic only: run against the exact official, SHA-pinned release to
// inspect packaging differences that the production extractor must handle.
func TestOfficialEIMArchiveLayout(t *testing.T){
 r,err:=eimReleaseFor("amd64");if err!=nil{t.Fatal(err)}
 ctx,cancel:=context.WithTimeout(context.Background(),90*time.Second);defer cancel()
 client:=&http.Client{Timeout:85*time.Second}
 b,err:=downloadPinnedEIM(ctx,client,r)
 if err!=nil{t.Fatal(err)}
 zipReader,err:=zip.NewReader(bytes.NewReader(b),int64(len(b)));if err!=nil{t.Fatal(err)}
 description:=""
 for _,f:=range zipReader.File{
  description+=fmt.Sprintf("\n- %q mode=%v size=%d",f.Name,f.Mode(),f.UncompressedSize64)
 }
 _,err=extractPinnedEIM(b,r)
 if err!=nil{t.Fatalf("Official EIM 0.21.1 asset cannot be parsed: %v; full archive layout: %s",err,description)}
}
