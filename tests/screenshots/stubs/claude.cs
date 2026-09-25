// Stand-in for claude.exe on the Windows screenshot runner: runs claude-stub.mjs (beside this executable) with Node and
// passes stdin, stdout and stderr straight through, so Kiln sees the same stream of events a real run produces.
// An executable rather than a .cmd shim: Kiln runs .cmd shims through `cmd.exe /d /s /c` without an outer pair of quotes,
// so cmd strips the quotes around the shim path and the launch fails.
using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
class ClaudeStub {
  static int Main(string[] args) {
    if (Array.IndexOf(args, "--version") >= 0) { Console.WriteLine("Claude Code"); return 0; }
    var script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "claude-stub.mjs");
    var start = new ProcessStartInfo("node", "\"" + script + "\"") { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
    using (var child = Process.Start(start)) {
      var output = Task.Run(() => child.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()));
      var errors = Task.Run(() => child.StandardError.BaseStream.CopyTo(Console.OpenStandardError()));
      Console.OpenStandardInput().CopyTo(child.StandardInput.BaseStream);
      child.StandardInput.Close();
      child.WaitForExit(); output.Wait(); errors.Wait();
      return child.ExitCode;
    }
  }
}
