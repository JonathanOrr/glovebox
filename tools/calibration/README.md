# 360° view calibration

The viewer's 360° view stitches the six dashcam videos together. To do that it
needs to know where each camera is on the car, which way it points, and how its
lens bends the picture. The built-in values in `static/js/pano.js` were solved
from one HW4 Model 3, a 2026 Highland. Mounting and lenses vary a little from car
to car, and other models put their cameras elsewhere, so these scripts let you
solve them again from your own footage. That matters most for earlier HW4 cars:
Tesla changed the camera sensor in 2025 (IMX963 before, IMX00N after), so their
lenses may differ from the built-in values. You don't need a trip to the car:
the scripts use ordinary drives on the USB stick.

## What you need

- A TeslaCam USB drive with some daytime driving in `SavedClips`, `SentryClips`
  or `RecentClips`. A few saved drives through town work well, because turns help.
- `ffmpeg` on your PATH.
- Python 3.10+ with `pip install -r requirements.txt` (numpy, scipy, OpenCV). A
  venv works fine.

## Run it

```sh
cd tools/calibration
python3 extract.py            # ~1 min: picks ~80 moments and saves their frames to work/
python3 match.py              # ~1 min: finds the same scenery across frames (uses all CPU cores)
python3 solve.py              # ~2 min: solves all cameras, writes ../../calibration.json
```

`solve.py` assumes a Model 3 Highland (HW4). For another car, pass its vehicle
file, e.g. `python3 solve.py --vehicle model_y_juniper_hw4` (see
[Vehicles](#vehicles)).

`extract.py` finds the TeslaCam folder on a mounted drive automatically; pass
the path if it doesn't. Reload the viewer and the 360° view uses
`calibration.json`. Delete that file to go back to the built-in values. Any
slider tweaks in the Calibrate panel are saved in your browser on top of the
file, and they're dropped whenever the file changes.

At the end, `solve.py` prints a median reprojection error. Around 1.5–2 px is a
good result. If it's much higher, or a camera's field of view looks odd, there
probably wasn't enough daytime driving. Try `extract.py --hours 7-19` or
`--seed 2` for a different sample.

## How it works

1. **extract.py** reads the telemetry Tesla embeds in each clip (speed, heading,
   gear) and picks moments while driving. Each moment is two instants a
   fraction of a second apart, some on straight road and some mid-turn. It
   saves every recorded camera's frames at both instants, plus how far the car
   moved and turned in between. It works out which cameras the car records
   from the clips, since HW3 cars may record fewer than HW4.
2. **match.py** finds the same scenery points (SIFT features, checked with
   RANSAC):
   - within each camera across the two instants;
   - between neighbouring cameras at the same instant.
3. **solve.py** runs a bundle adjustment. It adjusts every camera's yaw, pitch,
   roll and lens curve, plus a depth for every matched point, until each point
   lands where it was seen. The car's own motion is taken from the telemetry.
   It first fits each camera on its own from 15 starting angles around the
   vehicle file's rough aim, so that aim only needs to be within about 20°.
   Then it solves all the cameras together. Two constraints keep the solve
   stable:
   - Left and right cameras of the same kind share one lens, since they're the
     same part.
   - Camera positions are fixed. The footage alone can't pin them down, so they
     come from a 3D model.

## Vehicles

Each car is a file in `vehicles/`:

| File | Car |
|---|---|
| `model_3_highland_hw4` | Model 3 Highland (HW4), the default |
| `model_3_hw3` | Model 3 (HW3) |
| `model_y_juniper_hw4` | Model Y Juniper (HW4) |
| `model_y_juniper_standard_hw4` | Model Y Juniper Standard (HW4) |
| `model_y_hw3` | Model Y (HW3) |
| `model_s_2021_hw4` | Model S 2021+, including Plaid (HW4) |
| `model_x_2021_hw4` | Model X 2021+ (HW4) |
| `cybertruck_hw4` | Cybertruck (HW4) |

The cameras were placed by hand on 3D models of each car. Only the Model 3
Highland has been checked against real footage so far.

```json
{
 "name": "Model 3 Highland (HW4)",
 "eye": [0, 1.247, 1.294],
 "cameras": {
  "front": {"pos": [0.0, 1.287, 1.844], "aim": [0, -5]},
  "back":  {"pos": [-0.0485, 0.847, -0.901], "aim": [180, -18.4]},
  ...
 }
}
```

- **`pos`** is where each lens sits, in metres from the ground under the rear
  axle (x right, y up, z forward). Get these as accurately as you can: the
  solve keeps them fixed. On the Model 3, the rear camera really is about 5 cm
  left of centre.
- **`aim`** is a rough [yaw, pitch] in degrees (yaw + = right, pitch + = up).
  The solve finds the exact angles.
- **`eye`** is where the 360° view looks out from: roughly the middle of the
  cabin at head height.
- **`mask`** (optional) limits which part of a camera's picture the 360° view
  uses: a circle in the middle (radius in image widths) and a widest angle from
  the lens axis. It keeps out parts of the car that the camera sees around the
  edges of its frame. Without one, the rear camera gets
  `{"circle": 0.49, "maxAngle": 72}`, which trims the Model 3 Highland's trunk
  lip and plate bracket. `"mask": null` turns it off.
- **`lens`** (optional) is a starting [f, k1, k2] if a camera differs a lot from
  a Model 3's.

### Making them from a Blender model

`blender_cameras.py` reads camera positions and aims from a .blend. The .blend is
only read, never saved.
1. Each camera is a mesh with a single edge. Put the first vertex on the lens
   and the second along the direction the camera looks. Name them `Front_cam`,
   `L_pillar_cam`, `L_repeater_cam` and `Rear_cam`. You can add `R_…` versions
   too; if you don't, the right side is mirrored from the left.
2. For several cars in one file, give each car its own collection, named after
   the car. In each collection, put an empty called `Rear_axle` on the ground
   under the centre of the rear axle, with its y axis pointing forward. Then:

   ```sh
   blender -b cars.blend --python blender_cameras.py -- vehicles/
   ```

   This writes one vehicle file per collection.
3. For a single car without a `Rear_axle` empty, pass the axle position instead:

   ```sh
   blender -b car.blend --python blender_cameras.py -- vehicles/model_y.json "Model Y (HW4)" \
       --rear-axle-y -1.373 --ground-z 0
   ```

   - `--rear-axle-y` is the rear axle's Blender Y coordinate. Blender's axes are
     x right, y forward, z up.
   - `--ground-z` is where the tyres touch the ground.

   The script writes a rough `eye` just behind the front camera; check it and
   adjust if needed.

## Limits

- **On the Model 3, the front camera and the pillar cameras don't overlap.**
  There is a real blind spot between them, so that seam can't be checked
  against footage.
- **Nothing lines up at every distance.** The cameras sit up to 3.4 m apart, so
  objects can only line up at one distance at a time. The Focus slider in the
  360° view picks that distance.
