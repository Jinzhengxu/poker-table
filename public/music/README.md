# 背景音乐

牌桌放的是一个三首的小歌单，`app.js` 每轮随机洗顺序，一首放完接下一首
（之前是一首 8 分半的拉格泰姆单曲循环，打一晚上牌同一段听十几遍，腻）。
风格照着苹果那个 Texas Hold'em 找的：慢速布鲁斯 + lounge，酒吧背景的味道。

| 文件 | 曲名 | 时长 | 乐器 |
|---|---|---|---|
| `matts-blues.mp3` | Matt's Blues | 2:47 | 吉他、贝斯、鼓、风琴、口琴 |
| `octoblues.mp3` | OctoBlues | 4:16 | 鼓、贝斯、吉他、风琴（12 小节布鲁斯） |
| `backbay-lounge.mp3` | Backbay Lounge | 4:27 | 钢琴、吉他、鼓、贝斯（冷爵士 lounge） |

## 授权

三首都是 **Kevin MacLeod**（https://incompetech.com/）的作品，
授权方式 [Creative Commons: By Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)。

CC BY **要求署名可见**，所以 `public/index.html` 的「设置」面板里有一块署名，
换曲子时记得跟着改，别整块删掉。原作者对游戏类项目的要求就是
"credits 放在设置里能点到的地方"。

> 苹果 Texas Hold'em 里那几首是苹果的版权音乐，不能直接拿来分发，
> 所以这里找的是同一个路子的 CC BY 曲子。

## 转码参数

原始文件是 256～326kbps 的立体声。仓库里这三份是压过的，脚本两步走：

```bash
# 1) 先降单声道 —— 顺序很重要，立体声测完响度再 -ac 1 下混，
#    宽立体声素材会掉好几 dB，三首就对不齐了
ffmpeg -y -i src.mp3 -ac 1 -ar 44100 -c:a pcm_s24le mono.wav

# 2) 两遍 loudnorm：先量，再拿量出来的值归一（单遍是动态模式，落点会飘 3 dB）
ffmpeg -i mono.wav -af loudnorm=I=-18:TP=-1.5:LRA=11:print_format=json -f null -
ffmpeg -y -i mono.wav \
  -af "loudnorm=I=-18:TP=-1.5:LRA=11:measured_I=…:measured_TP=…:measured_LRA=…:measured_thresh=…:linear=true,\
afade=t=in:st=0:d=1.2,afade=t=out:st=<时长-3.5>:d=3.5" \
  -ar 44100 -codec:a libmp3lame -q:a 7 out.mp3
```

- **单声道**：当背景放，立体声没意义，文件小一半
- **loudnorm I=-18**：三首落在同一响度上，切歌不会忽大忽小，
  前端也就只要一个 `MUSIC_LEVEL` 管全部
- **首尾淡入淡出**：切歌是硬接的，两头留了淡出淡入，接缝处才不会"啪"一声
- **-q:a 7（约 48kbps）**：老录音的高频本来就没什么东西，再高纯属浪费

三份加起来 4.3MB / 11 分半。实测归一后分别是 -18.0 / -18.1 / -17.7 LUFS。

### 想加/换曲子

1. 按上面的参数压好，丢进 `public/music/`
2. `public/app.js` 里 `TRACKS` 加一行 `{ file: '…', title: '…' }`
3. `public/index.html` 设置面板里的署名跟着补上（CC BY 的曲子必须署名）

播放音量在 `public/app.js` 的 `MUSIC_LEVEL`，按 -18 LUFS 调好的，
换个响度差很多的文件会突然变吵或者听不见。
