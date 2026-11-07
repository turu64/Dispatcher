"""Dispatcher デモ動画 第1版の組み立て(cuts.json → seg/*.mp4 → concat → 字幕の焼き込み)。"""
import json
import os
import subprocess
import sys

V = os.path.dirname(os.path.abspath(__file__))
SOZAI = '/Users/turutaru/Documents/GitHub/Dispatcher/demo_sozai'
FONT = 'A P-OTF 新ゴ Pr6N'
W, H, FPS = 1920, 1080, 30
BG = '0x0b0f14'

# アプリの画面(1561x784)から切り出す 16:9 の範囲(x, y, w)
CROPS = {
    'map': (347, 28, 1214),
    'load': (0, 0, 835),
    'premise': (0, 100, 760),
    'policy': (460, 105, 640),
    'review': (470, 105, 640),
    'reach': (0, 28, 1214),
    'drivers': (0, 130, 600),
    'research': (0, 100, 760),
    'ai': (0, 28, 900),
    'approved': (0, 100, 700),
    'output': (470, 105, 640),
}
SHOT_FILE = {'map': 'load.jpg'}


def run(args):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        print(' '.join(args), file=sys.stderr)
        print(r.stderr[-3000:], file=sys.stderr)
        raise SystemExit(1)


def video_input(c, seg):
    """(入力の引数, フィルタ) を返す。フィルタの出力は [v]"""
    v = c['v']
    frames = int(round(seg * FPS))
    if v == 'clip':
        return (['-ss', str(c['ss']), '-t', str(seg), '-i', f"{SOZAI}/{c['src']}"],
                f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={FPS},setsar=1[v]")
    if v == 'previz':
        pid = c.get('pid', c['id'])
        path = f"{V}/img/pv-{pid}.png"
        if c['id'] == '2-1' or c['id'] == '15':
            return (['-f', 'lavfi', '-t', str(seg), '-i', f"color=c={BG}:s={W}x{H}:r={FPS}"], '[0:v]setsar=1[v]')
        return (['-loop', '1', '-t', str(seg), '-i', path],
                f"[0:v]scale={W}:{H},zoompan=z='1+0.04*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps={FPS},setsar=1[v]")
    if v == 'app':
        shot = c['shot']
        x, y, w = CROPS[shot]
        h = round(w * 9 / 16)
        path = f"{V}/img/{SHOT_FILE.get(shot, shot + '.jpg')}"
        # 切り出して 2 倍に広げてから、ゆっくり寄る(読みやすさのため細部を上げる)
        return (['-loop', '1', '-t', str(seg), '-i', path],
                f"[0:v]crop={w}:{h}:{x}:{y},scale={W * 2}:{H * 2}:flags=lanczos,"
                f"zoompan=z='1+0.06*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps={FPS},setsar=1[v]")
    # title / credits は色の背景だけ(文字は字幕で載せる)
    return (['-f', 'lavfi', '-t', str(seg), '-i', f"color=c={BG}:s={W}x{H}:r={FPS}"], '[0:v]setsar=1[v]')



CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
CSS = """html,body{margin:0;background:transparent}body{width:1920px;height:1080px;position:relative;font-family:"A P-OTF 新ゴ Pr6N",sans-serif;color:#fff}
.telops{position:absolute;left:80px;top:70px;display:flex;flex-direction:column;gap:18px;align-items:flex-start;max-width:1500px}
.telop{background:rgba(8,16,20,.86);border-left:10px solid #ffb43a;font-size:48px;font-weight:600;line-height:1.35;padding:10px 26px}
.small{position:absolute;right:40px;bottom:10px;font-size:24px;color:#ddd;background:rgba(0,0,0,.55);padding:4px 10px;max-width:1100px;text-align:right}
.sub{position:absolute;left:120px;right:120px;bottom:60px;text-align:center;text-wrap:balance}
.sub span{background:rgba(0,0,0,.66);font-size:46px;line-height:1.55;padding:6px 18px;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;text-align:center}
.big{font-size:120px;font-weight:700;color:#ffb43a;letter-spacing:.02em}.mid{font-size:54px;color:#e6e6e6}.cred{font-size:34px;color:#e6e6e6}
.title{font-size:150px;font-weight:700;color:#fff;letter-spacing:.03em}"""


def html_escape(t):
    return t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def shot_html(body, out):
    html = f"<!doctype html><html><head><meta charset='utf-8'><style>{CSS}</style></head><body>{body}</body></html>"
    hp = out[:-4] + '.html'
    open(hp, 'w', encoding='utf-8').write(html)
    run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1920,1080', '--default-background-color=00000000',
         f'--screenshot={out}', 'file://' + hp])


def center_body(c):
    cid = c['id']
    if cid == '2-1':
        return "<div class='center'><div class='mid'>2030年 バスの運転者</div><div class='big'>約3.6万人不足</div></div>"
    if cid == '5':
        return "<div class='center'><div class='title'>Dispatcher</div><div class='mid'>運転士が足りない朝の、減便ダイヤ判断支援</div></div>"
    if cid == '15':
        return ("<div class='center'><div class='mid'>AI が平日に戻した便 10 便</div><div class='mid'>道北バスが実際に残した便 21 便(お知らせ 10/25)</div>"
                "<div class='big'>一致 6 便</div></div>")
    if cid == '20':
        lines = ['データ:北海道オープンデータプラットフォーム「道北バス」GTFS(CC BY 4.0)', '地図:©OpenStreetMap Contributors / 国土数値情報・e-Stat を加工して作成',
                 '報道:HTB・STV・北海道新聞(2026年10月)/ 道北バスのお知らせ', 'ナレーション:macOS の読み上げ(仮)', 'dispatcher.turutaru.com ・ github.com/turu64/Dispatcher']
        return "<div class='center'>" + ''.join(f"<div class='cred'>{html_escape(x)}</div>" for x in lines) + '</div>'
    return ''


def make_overlays(c, i):
    """テロップ(カットの間ずっと)と字幕(ナレーションの間)の透明な PNG を作る"""
    tel = ''.join(f"<div class='telop'>{html_escape(t)}</div>" for t in (c.get('telop') or []))
    body = (f"<div class='telops'>{tel}</div>" if tel else '') + (f"<div class='small'>{html_escape(c['small'])}</div>" if c.get('small') else '') + center_body(c)
    ov = f"{V}/ov/{i:02d}-tel.png"
    shot_html(body, ov)
    sub = None
    if c['n']:
        sub = f"{V}/ov/{i:02d}-sub.png"
        shot_html(f"<div class='sub'><span>{html_escape(c['n'])}</span></div>", sub)
    return ov, sub


def make_segment(c, i):
    seg = c['seg']
    out = f"{V}/seg/{i:02d}.mp4"
    vin, vf = video_input(c, seg)
    if c['n']:
        ain = ['-i', f"{V}/tts/{c['id']}.aiff"]
        af = '[1:a]aresample=48000,adelay=300|300,apad,atrim=0:' + str(seg) + ',aformat=channel_layouts=stereo[a]'
    else:
        ain = ['-f', 'lavfi', '-t', str(seg), '-i', 'anullsrc=r=48000:cl=stereo']
        af = '[1:a]atrim=0:' + str(seg) + '[a]'
    ov, sub = make_overlays(c, i)
    oin = ['-loop', '1', '-t', str(seg), '-i', ov]
    of = f"[2:v]format=rgba[t];[v][t]overlay=0:0[v1]"
    last = 'v1'
    if sub:
        oin += ['-loop', '1', '-t', str(seg), '-i', sub]
        of += f";[3:v]format=rgba[s];[v1][s]overlay=0:0:enable='between(t,0.3,{0.3 + c['nd']:.2f})'[v2]"
        last = 'v2'
    run(['ffmpeg', '-v', 'error', '-y', *vin, *ain, *oin, '-filter_complex', f"{vf};{af};{of}", '-map', f'[{last}]', '-map', '[a]',
         '-t', str(seg), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', str(FPS),
         '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', out])
    return out


def ts(t):
    h = int(t // 3600)
    m = int(t % 3600 // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def esc(s):
    return s.replace('\n', '\\N')


def make_ass(cuts):
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,{FONT},46,&H00FFFFFF,&H00FFFFFF,&H00000000,&H9A000000,0,0,0,0,100,100,0,0,3,14,0,2,160,160,56,1
Style: Telop,{FONT},50,&H00FFFFFF,&H00FFFFFF,&H00141008,&H22141008,1,0,0,0,100,100,0,0,3,18,0,7,80,80,70,1
Style: Small,{FONT},26,&H00D8D8D8,&H00FFFFFF,&H00000000,&H88000000,0,0,0,0,100,100,0,0,3,8,0,9,60,60,40,1
Style: Big,{FONT},120,&H003AB4FF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,5,80,80,0,1
Style: Mid,{FONT},54,&H00E6E6E6,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,80,80,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev = []
    t = 0.0
    for c in cuts:
        s, e = t, t + c['seg']
        # テロップ(左上から縦に並べる)
        for k, line in enumerate(c.get('telop') or []):
            ev.append(f"Dialogue: 1,{ts(s + 0.2)},{ts(e - 0.1)},Telop,,0,0,{70 + k * 92},,{esc(line)}")
        if c.get('small'):
            ev.append(f"Dialogue: 1,{ts(s + 0.2)},{ts(e - 0.1)},Small,,0,0,0,,{esc(c['small'])}")
        if c['n']:
            ev.append(f"Dialogue: 2,{ts(s + 0.3)},{ts(min(e, s + 0.3 + c['nd']) )},Sub,,0,0,0,,{esc(c['n'])}")
        cid = c['id']
        if cid == '2-1':
            ev.append(f"Dialogue: 0,{ts(s)},{ts(e)},Mid,,0,0,0,,{{\\pos(960,400)}}2030年 バスの運転者")
            ev.append(f"Dialogue: 0,{ts(s)},{ts(e)},Big,,0,0,0,,{{\\pos(960,560)\\fad(400,0)}}約3.6万人不足")
        if cid == '5':
            ev.append(f"Dialogue: 0,{ts(s)},{ts(e)},Big,,0,0,0,,{{\\pos(960,470)\\c&HFFFFFF&\\fad(300,0)}}Dispatcher")
            ev.append(f"Dialogue: 0,{ts(s)},{ts(e)},Mid,,0,0,0,,{{\\pos(960,610)\\fad(300,0)}}運転士が足りない朝の、減便ダイヤ判断支援")
        if cid == '15':
            ev.append(f"Dialogue: 0,{ts(s)},{ts(e)},Mid,,0,0,0,,{{\\pos(960,330)}}AI が平日に戻した便  10 便")
            ev.append(f"Dialogue: 0,{ts(s)},{ts(e)},Mid,,0,0,0,,{{\\pos(960,420)}}道北バスが実際に残した便  21 便(お知らせ 10/25)")
            ev.append(f"Dialogue: 0,{ts(s)},{ts(e)},Big,,0,0,0,,{{\\pos(960,590)\\fad(500,0)}}一致 6 便")
        if cid == '20':
            lines = ['データ:北海道オープンデータプラットフォーム「道北バス」GTFS(CC BY 4.0)', '地図:©OpenStreetMap Contributors / 国土数値情報・e-Stat を加工して作成',
                     '報道:HTB・STV・北海道新聞(2026年10月)/ 道北バスのお知らせ', 'ナレーション:macOS 読み上げ(仮)', 'dispatcher.turutaru.com ・ github.com/turu64/Dispatcher']
            for k, line in enumerate(lines):
                ev.append(f"Dialogue: 0,{ts(s)},{ts(e)},Mid,,0,0,0,,{{\\pos(960,{330 + k * 90})\\fs34}}{line}")
        t = e
    open(f"{V}/subs.ass", 'w', encoding='utf-8').write(head + '\n'.join(ev) + '\n')


def main():
    cuts = json.load(open(f"{V}/cuts.json", encoding='utf-8'))
    segs = []
    for i, c in enumerate(cuts):
        segs.append(make_segment(c, i))
        print('seg', c['id'], c['seg'], flush=True)
    with open(f"{V}/concat.txt", 'w') as f:
        for p in segs:
            f.write(f"file '{p}'\n")
    run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', f"{V}/concat.txt", '-c', 'copy', f"{V}/nosub.mp4"])
    os.replace(f"{V}/nosub.mp4", f"{V}/dispatcher_demo_v1.mp4")
    print('done')


if __name__ == '__main__':
    main()
