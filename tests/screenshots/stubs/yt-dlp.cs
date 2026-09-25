// Stand-in for yt-dlp on the Windows screenshot runner: copies the demo video's captions and metadata from the
// ytdlp-fixture folder beside this executable into the working folder, which is what Kiln reads after running yt-dlp.
using System.IO;
class YtDlpStub {
  static int Main(string[] args) {
    var fixture = Path.Combine(System.AppDomain.CurrentDomain.BaseDirectory, "ytdlp-fixture");
    foreach (var file in Directory.GetFiles(fixture)) File.Copy(file, Path.Combine(Directory.GetCurrentDirectory(), Path.GetFileName(file)), true);
    return 0;
  }
}
