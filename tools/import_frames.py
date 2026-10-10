"""Import fighter clips from local frame folders into src/sprites/<key>/.

Each source folder holds clips as <clip>/<n>.png (n from 0, in game order),
like .claude/tmp/thales_frames from the reskin method. The clips are copied
to src/sprites/<key>/<clip>/, the manifest entry for <key> is updated (clip
name to frame count; other clips already listed are kept), skin tones are
lightened with tools/recolor_skin.py when --lighter-skin is given, and the
feet are thickened with tools/thicken_feet.py (red's pipeline), unless
--no-thicken is given.

usage: python tools/import_frames.py <source dir> <sprite key> [--lighter-skin] [--no-thicken]
"""
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from recolor_skin import recolor  # noqa: E402
from PIL import Image  # noqa: E402


def main(argv):
    args = [a for a in argv if not a.startswith('--')]
    flags = {a for a in argv if a.startswith('--')}
    src, key = args[0], args[1]
    sprites = os.path.join(ROOT, 'src', 'sprites')
    manifest_path = os.path.join(sprites, 'manifest.json')
    manifest = json.load(open(manifest_path, encoding='utf-8-sig'))
    entry = manifest.get(key, {})
    clips = sorted(d for d in os.listdir(src) if os.path.isdir(os.path.join(src, d)))
    for clip in clips:
        files = sorted((f for f in os.listdir(os.path.join(src, clip)) if f.lower().endswith('.png')),
                       key=lambda f: int(os.path.splitext(f)[0]))
        dest = os.path.join(sprites, key, clip)
        shutil.rmtree(dest, ignore_errors=True)
        os.makedirs(dest)
        for i, f in enumerate(files):
            im = Image.open(os.path.join(src, clip, f)).convert('RGBA')
            if '--lighter-skin' in flags:
                im = recolor(im)
            im.save(os.path.join(dest, f'{i}.png'))
        entry[clip] = len(files)
    manifest[key] = dict(sorted(entry.items()))
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=4)
    print(f'{len(clips)} clips imported into {key}: ' + ', '.join(f'{c} {entry[c]}' for c in clips))
    if '--no-thicken' not in flags:
        subprocess.run([sys.executable, os.path.join(HERE, 'thicken_feet.py'), key], check=True)


if __name__ == '__main__':
    main(sys.argv[1:])
