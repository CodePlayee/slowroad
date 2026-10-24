#!/usr/bin/env python3
"""Measurement helper for reference analysis. Writes nothing outside refs/slowroads/."""
import sys, json
from PIL import Image

def hexof(px):
    return '#%02x%02x%02x' % px[:3]

def col_profile(path, xfracs=(0.5,), yfracs=None):
    im = Image.open(path).convert('RGB')
    W, H = im.size
    out = {'size': [W, H]}
    if yfracs is None:
        yfracs = [i/20 for i in range(21)]
    rows = {}
    for xf in xfracs:
        x = min(W-1, int(xf*W))
        rows[f'x{xf}'] = [(round(yf,3), hexof(im.getpixel((x, min(H-1,int(yf*H)))))) for yf in yfracs]
    out['columns'] = rows
    return out

def sat_row(path, y):
    """mean saturation + value along a row"""
    im = Image.open(path).convert('HSV')
    W, H = im.size
    y = min(H-1, int(y*H))
    s = v = 0
    for x in range(0, W, 4):
        _, ss, vv = im.getpixel((x, y))
        s += ss; v += vv
    n = len(range(0, W, 4))
    return {'y': y, 'sat': round(s/n, 1), 'val': round(v/n, 1)}

def sample(path, pts):
    im = Image.open(path).convert('RGB')
    W, H = im.size
    res = []
    for (xf, yf) in pts:
        x = min(W-1, int(xf*W)); y = min(H-1, int(yf*H))
        res.append({'xy_frac': [xf, yf], 'px': [x, y], 'hex': hexof(im.getpixel((x, y)))})
    return {'size': [W, H], 'samples': res}

def patch(path, xf, yf, r=6):
    """mean colour of a 2r x 2r patch — robust vs JPEG noise"""
    im = Image.open(path).convert('RGB')
    W, H = im.size
    x = min(W-1, int(xf*W)); y = min(H-1, int(yf*H))
    tot = [0,0,0]; n = 0
    for dx in range(-r, r+1):
        for dy in range(-r, r+1):
            xx = max(0, min(W-1, x+dx)); yy = max(0, min(H-1, y+dy))
            p = im.getpixel((xx, yy))
            tot[0]+=p[0]; tot[1]+=p[1]; tot[2]+=p[2]; n+=1
    return hexof((tot[0]//n, tot[1]//n, tot[2]//n))

def horizon(path, x=0.5):
    """find strongest vertical luminance/colour gradient in upper 60% of frame"""
    im = Image.open(path).convert('RGB')
    W, H = im.size
    xx = int(x*W)
    best = []
    prev = None
    for y in range(2, int(H*0.75)):
        p = im.getpixel((xx, y))
        if prev:
            d = abs(p[0]-prev[0])+abs(p[1]-prev[1])+abs(p[2]-prev[2])
            best.append((d, y))
        prev = p
    best.sort(reverse=True)
    return [{'y': y, 'yfrac': round(y/H, 3), 'delta': d} for d, y in best[:6]]

if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'col':
        print(json.dumps(col_profile(sys.argv[2], [float(v) for v in sys.argv[3].split(',')]), indent=1))
    elif cmd == 'sample':
        pts = [tuple(float(v) for v in p.split(':')) for p in sys.argv[3].split(',')]
        print(json.dumps(sample(sys.argv[2], pts), indent=1))
    elif cmd == 'patch':
        for p in sys.argv[3].split(','):
            xf, yf = (float(v) for v in p.split(':'))
            print(f'{xf}:{yf} -> {patch(sys.argv[2], xf, yf)}')
    elif cmd == 'horizon':
        print(json.dumps(horizon(sys.argv[2], float(sys.argv[3]) if len(sys.argv)>3 else 0.5), indent=1))
    elif cmd == 'satrow':
        for y in [float(v) for v in sys.argv[3].split(',')]:
            print(y, sat_row(sys.argv[2], y))

def scan(path, yf, x0=0.0, x1=1.0, step=1):
    """print run-length of colour classes along a row: helps find lane markings"""
    im = Image.open(path).convert('RGB')
    W, H = im.size
    y = min(H-1, int(yf*H))
    out = []
    for x in range(int(x0*W), int(x1*W), step):
        p = im.getpixel((x, y))
        r,g,b = p
        mx, mn = max(p), min(p)
        if mx > 175 and mx-mn < 34: c = 'W'      # white marking
        elif r > 130 and g > 95 and b < 110 and r-b > 55: c = 'Y'  # yellow
        elif mx-mn < 30 and 55 < mx < 175: c = '.'  # asphalt grey
        else: c = ' '
        out.append(c)
    s = ''.join(out)
    # run-length encode
    runs = []
    cur = s[0]; n = 0
    for ch in s:
        if ch == cur: n += 1
        else:
            runs.append((cur, n)); cur = ch; n = 1
    runs.append((cur, n))
    return {'y': y, 'runs': [f'{c}x{n}' for c, n in runs if n > 1]}

def marks(path, yf, x0=0.0, x1=1.0, minrun=3):
    im = Image.open(path).convert('RGB')
    W, H = im.size
    y = min(H-1, int(yf*H))
    cls = []
    for x in range(int(x0*W), int(x1*W)):
        r,g,b = im.getpixel((x, y))
        mx, mn = max(r,g,b), min(r,g,b)
        if mx > 170 and mx-mn < 36: c='W'
        elif r>125 and g>90 and b<115 and r-b>50: c='Y'
        elif mx-mn < 32 and 50 < mx < 172: c='A'
        else: c='-'
        cls.append((x, c))
    runs=[]; s=cls[0][0]; cur=cls[0][1]
    for x,c in cls[1:]:
        if c!=cur:
            runs.append((cur, s, x-1, x-s)); cur=c; s=x
    runs.append((cur, s, cls[-1][0], cls[-1][0]-s+1))
    return {'y':y, 'runs':[f'{c} x{a}-{b} w{w}' for c,a,b,w in runs if w>=minrun and c in 'WYA']}
