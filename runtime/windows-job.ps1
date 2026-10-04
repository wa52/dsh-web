param([Parameter(Mandatory=$true)][string]$Spec, [string]$LaunchToken)
$ErrorActionPreference = 'Stop'
# A suspended launch is assigned before any Worker code can run. The OS owns
# descendant termination even if the Controller or this supervisor is killed.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
public static class DshWorkerJob {
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong r,w,o,rb,wb,ob; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long user,job; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public int cb; public string reserved,desktop,title; public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reservedSize; public IntPtr reservedBytes,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimit limits,int length);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting info,int length,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string cwd,ref Startup startup,out ProcessInfo info);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static Exception Error(string operation) { return new Exception(operation + " failed: " + Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes=0;
    foreach(char c in value) {
      if(c=='\\') { slashes++; continue; }
      if(c=='\"') { result.Append('\\',slashes*2+1); result.Append(c); slashes=0; continue; }
      result.Append('\\',slashes); result.Append(c); slashes=0;
    }
    result.Append('\\',slashes*2); return result.Append('"').ToString();
  }
  public static int Run(string executable,string[] args) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw Error("CreateJobObject");
    var limits=new ExtendedLimit(); limits.basic.flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway
    var info=new ProcessInfo();
    try {
      if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(ExtendedLimit)))) throw Error("SetInformationJobObject");
      var startup=new Startup(); startup.cb=Marshal.SizeOf(typeof(Startup)); startup.flags=0x100;
      startup.input=GetStdHandle(-10); startup.output=GetStdHandle(-11); startup.error=GetStdHandle(-12);
      var command=new StringBuilder(Quote(executable)); foreach(string arg in args) command.Append(' ').Append(Quote(arg));
      if(!CreateProcess(null,command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref startup,out info)) throw Error("CreateProcess");
      if(!AssignProcessToJobObject(job,info.process)) { TerminateProcess(info.process,1); throw Error("AssignProcessToJobObject"); }
      if(ResumeThread(info.thread)==0xffffffff) throw Error("ResumeThread");
      if(WaitForSingleObject(info.process,0xffffffff)!=0) throw Error("WaitForSingleObject");
      uint code; if(!GetExitCodeProcess(info.process,out code)) throw Error("GetExitCodeProcess");
      if(!TerminateJobObject(job,1)) throw Error("TerminateJobObject");
      for(int attempt=0;attempt<500;attempt++) {
        Accounting accounting;
        if(!QueryInformationJobObject(job,1,out accounting,Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw Error("QueryInformationJobObject");
        if(accounting.active==0) return unchecked((int)code);
        Thread.Sleep(10);
      }
      throw new Exception("Worker descendants did not stop within job termination budget");
    } finally { CloseHandle(job); if(info.thread!=IntPtr.Zero) CloseHandle(info.thread); if(info.process!=IntPtr.Zero) CloseHandle(info.process); }
  }
}
'@
$taskSpec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Spec)) | ConvertFrom-Json
try { exit [DshWorkerJob]::Run([string]$taskSpec.executable, [string[]]$taskSpec.args) }
catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
