"""Dispatcher デモ動画 第2版の組み立て。
1-1〜4-2 は利用者が作った ElevenLabs の音声(1本)をカットの境目で切って使い、6 以降は macOS の読み上げ(仮)。"""
import json
import os
import re
import subprocess
import sys

V = os.path.dirname(os.path.abspath(__file__))
SOZAI = '/Users/turutaru/Documents/GitHub/Dispatcher/demo_sozai'
INTRO_AUDIO = f'{SOZAI}/dispatcher_elevenlabs_1_1_to_4_2.mp3'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
W, H, FPS = 1920, 1080, 30
BG = '0x0b0f14'
PAD = 0.3
LEAD = 0.2  # 読み上げの後の余白(秒)

CROPS = {
    'map': (347, 28, 1214), 'load': (0, 0, 835), 'premise': (0, 100, 760), 'policy': (460, 105, 640),
    'review': (470, 105, 640), 'reach': (0, 28, 1214), 'drivers': (0, 130, 600), 'research': (0, 100, 760),
    'ai': (0, 28, 900), 'approved': (0, 100, 700), 'output': (470, 105, 640),
}
SHOT_FILE = {'map': 'load.jpg'}

# 冒頭の音声の切れ目(秒)。無音の位置(silencedetect -38dB 0.35 秒)の中央で切る
INTRO = [
    ('1-1', 0.00, 5.43, []),
    ('1-2', 5.43, 16.66, [12.58]),
    ('2-1', 16.66, 25.40, [21.53]),
    ('2-2', 25.40, 33.10, []),
    ('2-3', 33.10, 39.00, []),
    ('3-1', 39.00, 43.54, []),
    ('3-2', 43.54, 59.34, [54.58]),
    ('3-3', 59.34, 66.98, []),
    ('4-1', 66.98, 74.16, []),
    ('4-2', 74.16, 82.21, []),
]

CSS = """html,body{margin:0;background:transparent}body{width:1920px;height:1080px;position:relative;font-family:"A P-OTF 新ゴ Pr6N",sans-serif;color:#fff}
.telops{position:absolute;left:80px;top:70px;display:flex;flex-direction:column;gap:18px;align-items:flex-start;max-width:1500px}
.telop{background:rgba(8,16,20,.86);border-left:10px solid #ffb43a;font-size:48px;font-weight:600;line-height:1.35;padding:10px 26px}
.hl{color:#ffb43a}
.small{position:absolute;right:40px;bottom:10px;font-size:24px;color:#ddd;background:rgba(0,0,0,.55);padding:4px 10px;max-width:1100px;text-align:right}
.sub{position:absolute;left:120px;right:120px;bottom:60px;text-align:center;text-wrap:balance}
.sub span{background:rgba(0,0,0,.66);font-size:46px;line-height:1.55;padding:6px 18px;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;text-align:center}
.big{font-size:132px;font-weight:700;color:#ffb43a;letter-spacing:.02em;text-shadow:0 0 40px rgba(0,0,0,.8)}.mid{font-size:56px;color:#eef2f7;text-shadow:0 0 24px rgba(0,0,0,.9)}.cred{font-size:34px;color:#e6e6e6}
.title{font-size:168px;font-weight:700;color:#fff;letter-spacing:.03em}
.card{background:#121821;border:3px solid #2a3442;border-radius:14px;padding:22px 30px}
.h{color:#ffb43a;font-weight:700}
svg{display:block}"""


def run(args):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        print(' '.join(args)[:2000], file=sys.stderr)
        print(r.stderr[-3000:], file=sys.stderr)
        raise SystemExit(1)


def esc(t):
    t = t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    return re.sub(r'\*\*(.+?)\*\*', r"<span class='hl'>\1</span>", t)


def shot_html(body, out, bg='transparent'):
    css = CSS if bg == 'transparent' else CSS.replace('html,body{margin:0;background:transparent}', f'html,body{{margin:0;background:{bg}}}')
    hp = out[:-4] + '.html'
    open(hp, 'w', encoding='utf-8').write(f"<!doctype html><html><head><meta charset='utf-8'><style>{css}</style></head><body>{body}</body></html>")
    run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1920,1080', '--default-background-color=00000000',
         f'--screenshot={out}', 'file://' + hp])
    return out


# ---------- 作る図 ----------
ICON_BLDG = "<svg width='120' height='120' viewBox='0 0 24 24' fill='none' stroke='#e8edf3' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'><rect x='4' y='3' width='16' height='18' rx='1'/><path d='M9 21v-4h6v4M8 7h2M14 7h2M8 11h2M14 11h2'/></svg>"
ICON_WHEEL = "<svg width='120' height='120' viewBox='0 0 24 24' fill='none' stroke='#e8edf3' stroke-width='1.6' stroke-linecap='round'><circle cx='12' cy='12' r='9'/><circle cx='12' cy='12' r='2.2'/><path d='M3.5 10.5l6.4 1M20.5 10.5l-6.4 1M12 14.2V21'/></svg>"
ICON_PERSON = "<svg width='92' height='92' viewBox='0 0 24 24' fill='#ffb43a'><circle cx='12' cy='7' r='4'/><path d='M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8z'/></svg>"
P22_X0, P22_DX = 1274, 400  # 2-2 の人のアイコンの始めの位置と動く幅


def figure_2_2():
    """2-2:本社 → 運転席 の札(固定)と、動く人のアイコン"""
    panel = (f"<div style='position:absolute;right:90px;top:300px;width:620px;height:400px;background:rgba(8,16,20,.82);border-radius:18px'>"
             f"<div style='position:absolute;left:50px;top:40px;text-align:center'>{ICON_BLDG}<div style='font-size:36px;margin-top:14px'>本社</div></div>"
             f"<div style='position:absolute;left:230px;top:100px;font-size:64px;color:#8a95a5'>→</div>"
             f"<div style='position:absolute;right:50px;top:40px;text-align:center'>{ICON_WHEEL}<div style='font-size:36px;margin-top:14px'>運転席</div></div></div>")
    a = shot_html(panel, f'{V}/ov/fig-2-2-panel.png')
    b = shot_html(f"<div style='position:absolute;left:{P22_X0}px;top:590px'>{ICON_PERSON}</div>", f'{V}/ov/fig-2-2-person.png')
    return a, b


def figure_2_1():
    a = shot_html("<div class='center' style='padding-bottom:120px'><div class='mid'>2030年 バスの運転者</div><div style='height:150px'></div></div>", f'{V}/ov/fig-2-1-a.png')
    b = shot_html("<div class='center' style='padding-top:60px'><div class='big'>約3.6万人不足</div></div>", f'{V}/ov/fig-2-1-b.png')
    return a, b


def figure_4_2():
    return shot_html("<div style='position:absolute;inset:0;background:rgba(11,15,20,.985)'></div><div class='center'><div class='title'>Dispatcher</div>"
                     "<div class='mid'>運転士が足りない朝の、減便ダイヤ判断支援</div></div>", f'{V}/ov/fig-4-2.png')


def figure_14():
    """14:Managed Agents の構造。3 段で出す(セッションと調整役 → 6 つの操作 → 調査役)"""
    ops = ['減便の方針の適用', '便を平日に戻す', '元に戻す', '影響の要約', '便の検索', '検証']
    chips = ''.join(f"<div style='background:#1b2430;border:2px solid #34404f;border-radius:10px;padding:10px 18px;font-size:30px'>{o}</div>" for o in ops)
    session = ("<div style='position:absolute;left:150px;top:50px;width:1620px;height:790px;border:3px dashed #4a5b70;border-radius:24px'></div>"
               "<div style='position:absolute;left:190px;top:70px;font-size:40px' class='h'>Claude Managed Agents <span style='color:#cfd6df;font-weight:400'>― 1 つのセッション</span></div>"
               "<div class='card' style='position:absolute;left:600px;top:160px;width:660px;text-align:center'><div class='h' style='font-size:48px'>調整役</div>"
               "<div style='font-size:34px;margin-top:6px'>Claude Sonnet 5.5 ・ 会話と判断</div></div>")
    lines = ("<svg style='position:absolute;left:0;top:0' width='1920' height='1080'><path d='M930 378 V408 H560 V440' stroke='#6b7a8e' stroke-width='4' fill='none'/>"
             "<path d='M930 378 V408 H1360 V440' stroke='#6b7a8e' stroke-width='4' fill='none'/></svg>")
    left = (f"<div class='card' style='position:absolute;left:210px;top:450px;width:700px'><div class='h' style='font-size:40px'>6 つの操作</div>"
            f"<div style='font-size:28px;color:#aab4c0;margin:4px 0 16px'>ブラウザのコードが実行・検証し、差分を見せる</div>"
            f"<div style='display:flex;flex-wrap:wrap;gap:12px'>{chips}</div></div>")
    stack = ''.join(f"<div class='card' style='position:absolute;left:{1010 + k * 26}px;top:{450 + k * 26}px;width:640px;height:250px'></div>" for k in (2, 1))
    right = (stack + "<div class='card' style='position:absolute;left:1010px;top:450px;width:640px;height:250px'><div class='h' style='font-size:40px'>調査役 × 施設の数</div>"
             "<div style='font-size:32px;margin-top:6px'>Claude Haiku 5.5</div><div style='font-size:28px;color:#aab4c0;margin-top:14px'>workflow run で並行に、Web 検索と<br>Web の読み込みだけで調べる</div></div>"
             "<div style='position:absolute;left:1010px;top:770px;font-size:28px;color:#aab4c0'>結果は出典つきでサーバーに保存し、使い回す</div>")
    base = shot_html(session, f'{V}/ov/fig-14-a.png', bg='#0b0f14')
    b = shot_html(lines + left, f'{V}/ov/fig-14-b.png')
    c = shot_html(right, f'{V}/ov/fig-14-c.png')
    return base, b, c


CREDITS = ['データ:北海道オープンデータプラットフォーム「道北バス」GTFS(CC BY 4.0)', '地図:©OpenStreetMap Contributors / 国土数値情報・e-Stat を加工して作成',
           '報道:HTB・STV・北海道新聞(2026年10月)/ 道北バスのお知らせ', 'ナレーション:ElevenLabs(冒頭)/ macOS の読み上げ(仮)',
           'dispatcher.turutaru.com ・ github.com/turu64/Dispatcher']


def center_body(c):
    cid = c['id']
    if cid == '16':
        return ("<div class='center' style='background:#0b0f14'><div class='mid'>AI が平日に戻した便 10 便</div><div class='mid'>道北バスが実際に残した便 21 便(お知らせ 10/25)</div>"
                "<div class='big'>一致 6 便</div></div>")
    if cid == '20':
        return "<div class='center'>" + ''.join(f"<div class='cred'>{esc(x)}</div>" for x in CREDITS) + '</div>'
    return ''


# ---------- 映像 ----------
def zoom(frames, z=0.05):
    return f"zoompan=z='1+{z}*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps={FPS}"


def video_input(c, seg):
    v = c['v']
    frames = int(round(seg * FPS))
    if v == 'clip':
        blur = ',boxblur=10:2,eq=brightness=-0.08' if c.get('blur') else ''
        return (['-ss', str(c['ss']), '-t', str(seg), '-i', f"{SOZAI}/{c['src']}"],
                f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={FPS}{blur},setsar=1[v]")
    if v == 'image':
        return (['-loop', '1', '-t', str(seg), '-i', f"{V}/img/{c['img']}"], f"[0:v]scale={W * 2}:{H * 2},{zoom(frames, c.get('z', 0.04))},setsar=1[v]")
    if v == 'app':
        x, y, w = CROPS[c['shot']]
        h = round(w * 9 / 16)
        path = f"{V}/img/{SHOT_FILE.get(c['shot'], c['shot'] + '.jpg')}"
        return (['-loop', '1', '-t', str(seg), '-i', path],
                f"[0:v]crop={w}:{h}:{x}:{y},scale={W * 2}:{H * 2}:flags=lanczos,{zoom(frames, 0.06)},setsar=1[v]")
    return (['-f', 'lavfi', '-t', str(seg), '-i', f"color=c={BG}:s={W}x{H}:r={FPS}"], '[0:v]setsar=1[v]')


def subtitle_spans(c):
    """[(文, 始め, 終わり)](カットの中の秒)"""
    if 'subs' in c:
        return c['subs']
    if not c['n']:
        return []
    parts = [p + '。' for p in c['n'].split('。') if p.strip()] or [c['n']]
    if c['n'] and not c['n'].endswith('。'):
        parts[-1] = parts[-1][:-1]
    total = sum(len(p) for p in parts)
    t, out = LEAD, []
    for p in parts:
        d = c['nd'] * len(p) / total
        out.append((p, t, t + d))
        t += d
    return out


def make_segment(c, i):
    seg = c['seg']
    out = f"{V}/seg/{i:02d}.mp4"
    vin, vf = video_input(c, seg)
    if 'a0' in c:
        ain = ['-ss', f"{c['a0']:.3f}", '-t', f'{seg:.3f}', '-i', INTRO_AUDIO]
        af = f'[1:a]aresample=48000,apad,atrim=0:{seg},aformat=channel_layouts=stereo[a]'
    elif c['n']:
        ain = ['-i', f"{V}/tts/{c['id']}.aiff"]
        af = f'[1:a]aresample=48000,volume=5dB,adelay={int(LEAD*1000)}|{int(LEAD*1000)},apad,atrim=0:{seg},aformat=channel_layouts=stereo[a]'
    else:
        ain = ['-f', 'lavfi', '-t', str(seg), '-i', 'anullsrc=r=48000:cl=stereo']
        af = f'[1:a]atrim=0:{seg}[a]'
    # 重ねる絵: (path, 始め, フェード, x の式)
    layers = []
    cid = c['id']
    if cid == '2-1':
        a, b = figure_2_1()
        layers += [(a, 0, 0.4, None), (b, 1.4, 0.8, None)]
    if cid == '2-2':
        a, b = figure_2_2()
        layers += [(a, 0.6, 0.4, None), (b, 0.6, 0.4, f"if(lt(t,2.2),0,if(lt(t,4.6),(t-2.2)/2.4*{P22_DX},{P22_DX}))")]
    if cid == '4-2':
        layers += [(figure_4_2(), c.get('logo_at', 5.4), 0.6, None)]
    if cid == '14':
        base, b, cc = figure_14()
        layers += [(base, 0, 0.3, None), (b, 2.0, 0.5, None), (cc, 4.6, 0.5, None)]
    tel = ''.join(f"<div class='telop'>{esc(t)}</div>" for t in (c.get('telop') or []))
    body = (f"<div class='telops'>{tel}</div>" if tel else '') + (f"<div class='small'>{esc(c['small'])}</div>" if c.get('small') else '') + center_body(c)
    if body:
        tl = c.get('logo_at')
        layers.insert(0, (shot_html(body, f'{V}/ov/{i:02d}-tel.png'), 0, 0, None) + ((tl,) if tl else ()))
    for k, (text, t0, t1) in enumerate(subtitle_spans(c)):
        p = shot_html(f"<div class='sub'><span>{esc(text)}</span></div>", f'{V}/ov/{i:02d}-sub{k}.png')
        layers.append((p, t0, 0, None, min(t1, seg - 0.05)))
    oin, of, last = [], [], 'v'
    for k, L in enumerate(layers):
        path, t0, fade, xexpr = L[:4]
        t1 = L[4] if len(L) > 4 else None
        idx = 2 + k
        oin += ['-loop', '1', '-t', str(seg), '-i', path]
        f = f"[{idx}:v]format=rgba"
        if fade:
            f += f",fade=in:st={t0}:d={fade}:alpha=1"
        f += f"[o{k}]"
        en = f"between(t,{t0:.2f},{t1:.2f})" if t1 is not None else f"gte(t,{t0:.2f})"
        x = f":x='{xexpr}'" if xexpr else ''
        f += f";[{last}][o{k}]overlay=0:0{x}:enable='{en}'[l{k}]" if not x else f";[{last}][o{k}]overlay=y=0{x}:enable='{en}'[l{k}]"
        of.append(f)
        last = f'l{k}'
    fc = ';'.join([vf, af] + of)
    run(['ffmpeg', '-v', 'error', '-y', *vin, *ain, *oin, '-filter_complex', fc, '-map', f'[{last}]', '-map', '[a]',
         '-t', str(seg), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', str(FPS),
         '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', out])
    return out


def build_cuts():
    cuts = json.load(open(f'{V}/cuts2.json', encoding='utf-8'))
    nar = json.load(open(f'{V}/tts/nar.json', encoding='utf-8'))
    intro = {cid: (a, b, splits) for cid, a, b, splits in INTRO}
    for c in cuts:
        cid = c['id']
        if cid in intro:
            a, b, splits = intro[cid]
            c['a0'], c['seg'] = a, round(b - a, 3)
            sents = [p + '。' for p in c['n'].split('。') if p.strip()]
            if len(splits) + 1 == len(sents):
                edges = [0.0] + [s - a for s in splits] + [c['seg'] - 0.1]
                c['subs'] = [(sents[k], edges[k], edges[k + 1]) for k in range(len(sents))]
            elif splits:  # 1 文を読点で 2 つに分ける(3-2)
                cut = c['n'].index(c['split_at']) + len(c['split_at'])
                m = splits[0] - a
                c['subs'] = [(c['n'][:cut], 0.0, m), (c['n'][cut:], m, c['seg'] - 0.1)]
            else:
                c['subs'] = [(c['n'], 0.0, c['seg'] - 0.1)]
        elif c['n']:
            c['nd'] = nar['nd'][cid]
            c['seg'] = round(max(c['min'], c['nd'] + LEAD + PAD), 2)
        else:
            c['seg'] = c['min']
    return cuts


def main():
    cuts = build_cuts()
    only = set(sys.argv[1:])
    segs = []
    for i, c in enumerate(cuts):
        p = f"{V}/seg/{i:02d}.mp4"
        if not only or c['id'] in only:
            make_segment(c, i)
            print('seg', c['id'], c['seg'], flush=True)
        segs.append(p)
    total = sum(c['seg'] for c in cuts)
    print('total', round(total, 2))
    if only:
        return
    with open(f'{V}/concat.txt', 'w') as f:
        for p in segs:
            f.write(f"file '{p}'\n")
    run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', f'{V}/concat.txt', '-c', 'copy', f'{V}/dispatcher_demo_v2.mp4'])
    json.dump(cuts, open(f'{V}/cuts2.resolved.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('done')


if __name__ == '__main__':
    main()
