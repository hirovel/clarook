// 只在用户请求粘贴时访问系统剪贴板,没有后台轮询或自动发送。
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import type { ImageInput } from "../src/images.js";

export type ClipboardInput = { text?: string; image?: ImageInput };
const run = promisify(execFile);

export async function imageFromPath(
  text: string,
  cwd = process.cwd(),
): Promise<ImageInput | undefined> {
  const file = text
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/^'(.*)'$/, "$1");
  if (!/\.(png|jpe?g|gif|webp)$/i.test(file) || /[\r\n]/.test(file)) return;
  const path = resolve(cwd, file);
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return;
  if (info.size > 48 * 1024 * 1024)
    throw new Error("Image exceeds the 48 MiB attachment read limit");
  const bytes = await readFile(path);
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216
      ? "image/jpeg"
      : /^GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii"))
        ? "image/gif"
        : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
          ? "image/webp"
          : undefined;
  if (!mimeType) throw new Error("Unsupported or invalid image signature");
  return { mimeType, data: bytes.toString("base64"), name: basename(file) };
}

export async function readClipboardInput(): Promise<ClipboardInput> {
  if (process.platform === "win32") {
    const script = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -ne $img) {
  $stream = New-Object System.IO.MemoryStream
  try {
    $img.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    @{ image = @{ mimeType = 'image/png'; data = [Convert]::ToBase64String($stream.ToArray()); name = 'Clipboard image' } } | ConvertTo-Json -Compress
  } finally { $stream.Dispose(); $img.Dispose() }
} else { @{ text = [System.Windows.Forms.Clipboard]::GetText() } | ConvertTo-Json -Compress }
`;
    const result = await run("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
    return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim()) as ClipboardInput;
  }
  if (process.platform === "linux") {
    const command = process.env.WAYLAND_DISPLAY ? "wl-paste" : "xclip";
    const args = process.env.WAYLAND_DISPLAY
      ? ["--type", "image/png"]
      : ["-selection", "clipboard", "-t", "image/png", "-o"];
    const result = await run(command, args, {
      encoding: "buffer",
      timeout: 5000,
      maxBuffer: 48 * 1024 * 1024,
    });
    return {
      image: {
        mimeType: "image/png",
        data: result.stdout.toString("base64"),
        name: "Clipboard image",
      },
    };
  }
  throw new Error(
    "Image clipboard is supported on Windows and Linux. Paste an image file path instead.",
  );
}
