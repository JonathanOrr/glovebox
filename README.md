# TeslaCam Viewer

Watch your Tesla's dashcam and Sentry recordings on your computer, straight from
the car's USB drive:

- all six cameras playing together, in sync;
- speed, pedals, steering, indicators and Autopilot from the car's own data;
- a map of where each recording happened, and a small map that follows along;
- a 360° view that stitches the cameras into one picture around the car, including
  a view from straight above;
- deleting recordings you don't want to keep.

Everything runs on your own computer. Your recordings are never uploaded.

## Get it

1. On this page, click the green **Code** button, then **Download ZIP**.
2. Unzip it: double-click the downloaded file. Put the folder somewhere you'll find
   it again, for example in Documents.

## Start it

Plug the USB drive from your car into your computer. Then open the folder and
double-click the start file for your computer:

| Computer | File to double-click |
|---|---|
| Windows | **Start on Windows.bat** |
| Mac | **Start on Mac.command** |
| Linux | **Start on Linux.sh** |

A black window opens and your web browser shows the viewer. Keep the black window
open while you use the viewer, and close it when you're done.

The first start takes a couple of minutes, because it downloads what the viewer
needs. After that it starts in seconds.

**If your computer won't open the file:**

- **Windows** may say "Windows protected your PC". Click **More info**, then
  **Run anyway**.
- **Mac** may say the file "can't be opened because it is from an unidentified
  developer". Right-click (or Control-click) the file, choose **Open**, then
  **Open** again. You only need to do this once.
- **Linux**: right-click the file and choose **Run as a Program**. If there's no
  such option, open a terminal in the folder and type `./"Start on Linux.sh"`.

If you've copied the TeslaCam folder to your computer instead of using the USB
drive, put it in your home folder, Desktop or Downloads, and the viewer will find
it there. On Windows you can also drag the TeslaCam folder onto the start file.

## Use it

Click a recording on the left to play it.

| Key | Does |
|---|---|
| Space | Play / pause |
| ← → | Back / forward 5 seconds |
| , . | Back / forward one frame |
| ↑ ↓ | Previous / next recording |
| 1–6 | Show one camera large |
| V | 360° view |
| M | Show or hide the follow map |
| Delete | Delete the recording from the USB drive (asks first) |

The **Map** button at the top of the list shows all your recordings on a map.

## Fit the 360° view to your car

The 360° view needs to know exactly where each camera on your car points. It comes
set up for a 2026 Model 3. Cameras sit a little differently on every car, and other
models put them elsewhere, so you can fit it to yours in one click:

1. Make sure the USB drive has a few recordings of daytime driving. Saved clips
   (tap the dashcam icon while driving) and Sentry clips both work. Drives through
   town with some turns are best.
2. Play any recording, press **360°**, then **Calibrate**.
3. Pick your car and click **Calibrate from my drives**.

It takes about five minutes, and you can keep watching while it works. When it's
done, the 360° view switches to your car's calibration. If you liked the old one
better, click **Undo last change**.

If you drive a 2026 Model 3, the built-in calibration was carefully measured on
one and will probably fit your car better than this quick one. Try it first.

The **Focus** slider picks the distance at which the cameras line up best. The
cameras sit up to 3.4 m apart on the car, so things can only line up perfectly at
one distance at a time.

## Good to know

- **Maps** need an internet connection. They come from OpenFreeMap; only the map
  area being shown is requested, never your recordings.
- **Encrypted recordings.** Newer Tesla software can encrypt dashcam recordings
  (they appear in an `EncryptedClips` folder). The viewer can't play those. Turn
  off encryption in the car's dashcam settings to record viewable clips.
- **Telemetry** (speed, steering and so on) is only in recordings made by recent
  Tesla software. Older clips play without it.
- **Deleting** a recording removes it from the USB drive for good.

## For developers

The viewer is a small Python web server (`server.py`, no extra packages) and a
plain JavaScript page in `static/`. Run it with `python3 server.py`, optionally
passing the TeslaCam folder. Calibration needs the packages in `requirements.txt`;
[tools/calibration](tools/calibration/README.md) explains how it works and how to
add a car.
