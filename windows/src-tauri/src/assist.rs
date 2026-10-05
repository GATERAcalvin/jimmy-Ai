// Assist — look at the screen and answer, with Gemini.
//
// The screenshot is taken here (PowerShell and System.Drawing on Windows, so no
// extra native code), sent to Gemini, and discarded: nothing is written anywhere
// except a temporary file that is deleted straight away.

use crate::gemini;

const SYSTEM: &str = "You are Jimmy, a personal assistant that lives at the top of the user's screen. \
You may be given a screenshot of their screen and/or a transcript of audio they just heard. \
Answer the user's request directly and briefly: your answer may be read aloud, so use short plain sentences, \
no markdown, no tables and no bullet symbols. If the request is a question with options, give the answer first \
and a one-line reason after it. If you cannot see what you need on the screen, say what is missing.";

/// A JPEG of the primary screen, scaled to at most 1600 px wide: (mime, base64).
#[cfg(windows)]
pub fn capture_screen() -> Result<(String, String), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let path = std::env::temp_dir().join(format!("jimmy-screen-{}.jpg", std::process::id()));
    let script = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[Dpi]::SetProcessDPIAware() | Out-Null
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$g.Dispose()
$w = [Math]::Min(1600, $b.Width); $h = [int]($b.Height * $w / $b.Width)
$out = New-Object System.Drawing.Bitmap $w, $h
$g2 = [System.Drawing.Graphics]::FromImage($out)
$g2.InterpolationMode = 'HighQualityBicubic'
$g2.DrawImage($bmp, 0, 0, $w, $h)
$g2.Dispose()
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 82L
$out.Save($env:JIMMY_SHOT, $enc, $ep)
"#;
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .env("JIMMY_SHOT", &path)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("Could not start PowerShell to read the screen: {e}"))?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&path);
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Could not capture the screen: {}", err.trim().chars().take(200).collect::<String>()));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read the screenshot: {e}"))?;
    let _ = std::fs::remove_file(&path);
    Ok(("image/jpeg".into(), crate::claude::base64_for(&bytes)))
}

#[cfg(not(windows))]
pub fn capture_screen() -> Result<(String, String), String> {
    Err("Reading the screen is only available on Windows.".into())
}

/// Answers `prompt`, looking at the screen when asked and using `heard` (a rolling
/// transcript of what the microphone picked up) as extra context.
pub async fn ask(prompt: &str, screen: bool, heard: &str) -> Result<String, String> {
    if !gemini::has_key() {
        return Err("Add your Gemini key in Settings → Voice first.".into());
    }
    let images = if screen { vec![capture_screen()?] } else { vec![] };
    Ok(gemini::ask(SYSTEM, &compose(prompt, screen, heard), &images).await?)
}

/// The text part of the request. Kept separate so it can be tested.
pub fn compose(prompt: &str, screen: bool, heard: &str) -> String {
    let mut out = String::new();
    let heard = heard.trim();
    if !heard.is_empty() {
        out.push_str("Recently heard (oldest first, may contain mistakes):\n");
        out.push_str(heard);
        out.push_str("\n\n");
    }
    let prompt = prompt.trim();
    if prompt.is_empty() {
        out.push_str(if screen {
            "The user gave no spoken instruction. Work out what they need from the screen (and what was heard) and answer it."
        } else {
            "The user gave no spoken instruction. Work out what they need from what was heard and answer it."
        });
    } else {
        out.push_str("The user says: ");
        out.push_str(prompt);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_instruction_asks_jimmy_to_work_it_out() {
        let c = compose("  ", true, "");
        assert!(c.contains("no spoken instruction") && c.contains("screen"));
        assert!(!compose("", false, "").contains("screen"));
    }

    #[test]
    fn heard_text_comes_first() {
        let c = compose("what is the answer?", false, "Question three: what is 2+2?");
        assert!(c.starts_with("Recently heard"));
        assert!(c.ends_with("The user says: what is the answer?"));
    }
}
