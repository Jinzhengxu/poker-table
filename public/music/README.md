# 背景音乐

## lounge.mp3

**Solace (A Mexican Serenade)** —— Scott Joplin，1909 年出版的慢速拉格泰姆，
用一台旧立式钢琴弹的。8 分 50 秒，正好是牌桌背景要的那种老酒馆味道。

| | |
|---|---|
| 作曲 | Scott Joplin（1868–1917），作品 1909 年出版，**已进入公有领域** |
| 录音来源 | https://archive.org/details/Solace_201812 |
| 录音授权 | [CC Public Domain Mark 1.0](https://creativecommons.org/publicdomain/mark/1.0/) |

作曲者 1917 年去世、作品 1909 年出版，著作权早已过期；这份录音由上传者标注为
公有领域。两层都干净，可以随仓库分发。

### 转码参数

原始文件是 12MB 的立体声 192kbps。仓库里这份是压过的：

```
ffmpeg -i solace.mp3 \
  -af "loudnorm=I=-18:TP=-1.5:LRA=11,afade=t=in:st=0:d=1.2,afade=t=out:st=527.1:d=3.5" \
  -ac 1 -ar 44100 -codec:a libmp3lame -q:a 7 \
  lounge.mp3
```

- **单声道**：独奏钢琴当背景，立体声没意义，文件小一半
- **loudnorm I=-18**：统一响度，换曲子时不用重新调播放音量
- **首尾淡入淡出**：`<audio loop>` 是硬接回开头的，两头留了淡出淡入，循环处才不会"啪"一声
- **-q:a 7（约 48kbps）**：实测这段录音 13kHz 以上本来就只有 -67dB（老钢琴录音没什么高频），
  再高的码率纯属浪费——q5/q6/q7 的高频残留量几乎一样，所以取最小的

结果 3.1MB / 47.6kbps。

### 想换成别的曲子

把新文件放成 `public/music/lounge.mp3` 就行，前端不用改。建议照上面的参数压一遍，
尤其是 `loudnorm` 和首尾淡入淡出——播放音量在 `public/app.js` 的 `MUSIC_LEVEL`，
按 -18 LUFS 调好的，换个响度差很多的文件会突然变吵或者听不见。
