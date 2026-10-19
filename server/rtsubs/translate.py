"""Per-chunk ZH->VI translation that understands the whole story.

The video is a file, so the server transcribes it far ahead of playback (ASR runs ~5x faster than real
time). `understand()` reads that SOURCE transcript and builds the story bible from it; it runs before the
first chunk is translated (on the first ~60 s) and once more when the whole video is transcribed. The bible
is never learned from our own translations, so a wrong translation cannot become canon.

Prompt layout (most stable first, so providers can reuse the cached prefix):
  1. system      - fixed rules + example                  (never changes)
  2. user        - story bible                            (changes at most twice per video)
  3. user        - source transcript                      (changes at most twice per video)
  4. user        - previous lines + lines to translate    (changes every request)
"""
from __future__ import annotations

import json
import re
import threading

from .asr import Seg
from .config import Settings

SYSTEM = """Bạn là dịch giả lồng tiếng chuyên nghiệp, dịch video/bài giảng/phim sang tiếng Việt tự nhiên, chuẩn xác và trôi chảy. Bản dịch sẽ được máy đọc to (TTS) đúng vào khung thời gian của từng câu gốc.

# Dữ liệu bạn nhận (theo thứ tự)
1. STORY BIBLE / THUẬT NGỮ: nhân vật, vai người nói, cách xưng hô, thuật ngữ chuyên ngành (nếu là bài giảng, khóa học) và các lỗi nhận dạng nếu có. Được lập từ toàn bộ nội dung nên đáng tin hơn suy đoán cục bộ.
2. TRANSCRIPT: lời thoại gốc của video (toàn bộ, hoặc mới đến một mốc thời gian nếu có ghi chú). Chỉ để hiểu cốt truyện, ngữ cảnh bài học, đoạn sau của nội dung. KHÔNG dịch phần này.
3. Yêu cầu dịch, là JSON gồm:
   - previous_lines: vài câu liền trước (gốc + vi) để nối mạch. KHÔNG dịch lại.
   - translate: các câu cần dịch theo thứ tự thoại, mỗi câu là {id, zh, max_chars}. (zh là văn bản nguồn gốc, có thể là tiếng Anh, tiếng Trung hoặc ngôn ngữ khác).

# Quy tắc
1. Nguồn là lời thoại gốc hoặc nhận dạng giọng nói: hãy nắm bắt ý chính xác từ toàn bộ ngữ cảnh (bible, transcript, câu lân cận) rồi dịch tự nhiên, chuẩn nghĩa tiếng Việt. Không dịch từng chữ máy móc: nếu nghĩa đen vô lý trong ngữ cảnh thì chọn cách diễn đạt hợp lý.
2. Tên riêng và thuật ngữ: bible là chuẩn, dùng đúng y như ghi. Tên người/địa danh Trung Quốc thì dùng âm Hán-Việt (曹→Tào); thuật ngữ chuyên ngành tiếng Anh (như Machine Learning, AI, Deep Learning, v.v.) thì dịch chuẩn theo thuật ngữ học thuật tiếng Việt hoặc giữ nguyên thuật ngữ phổ biến quốc tế nếu người trong ngành hay dùng.
3. Xưng hô theo bible và ngữ cảnh: bài giảng thì xưng hô giảng viên - học viên ("tôi - các bạn" hoặc "chúng ta"); phim/video đối thoại thì xưng hô nhất quán theo vai.
4. Mỗi id được đọc to riêng lẻ, nên bản dịch của mỗi id phải là một cụm trọn nghĩa, nghe tự nhiên khi đứng một mình. KHÔNG kết thúc bằng dấu phẩy, chấm phẩy hay hai chấm; kết thúc bằng . ? ! (chỉ dùng … khi người nói thật sự bỏ lửng).
5. Khẩu ngữ, súc tích, đọc trôi chảy, dùng từ người Việt thật sự nói. Không vượt max_chars; nếu dài thì bỏ từ đệm/lặp, không bỏ ý chính. Không thêm thông tin không có trong nguồn, không giải thích, không chú thích.
6. Lời cảm thán, từ đệm vẫn phải dịch hoặc chuyển ngữ tự nhiên ("Ồ!", "Vâng"), không để trống.
7. Mỗi id đúng một bản dịch; không gộp, tách, đổi hay bỏ id. Mỗi bản dịch là một dòng, không có ký tự xuống dòng.
8. Chỉ trả về JSON hợp lệ, không Markdown: {"items":[{"id":0,"vi":"..."}]}

# Ví dụ
translate: [{"id":0,"zh":"In this lecture, we will study convolutional neural networks.","max_chars":35},{"id":1,"zh":"It is widely used in computer vision.","max_chars":25}]
trả về: {"items":[{"id":0,"vi":"Trong bài giảng này, chúng ta sẽ học về mạng nơ-ron tích chập."},{"id":1,"vi":"Nó được ứng dụng rộng rãi trong thị giác máy tính."}]}"""

UNDERSTAND_SYSTEM = """Bạn là biên tập viên kịch bản và thuật ngữ chuyên nghiệp. Bạn nhận TRANSCRIPT (có mốc thời gian) của một video/bài giảng sắp được lồng tiếng sang tiếng Việt, và lập STORY BIBLE / BẢNG THUẬT NGỮ để người dịch dịch nhất quán, đúng ngữ cảnh.

Lưu ý: đọc toàn bộ để hiểu chủ đề bài học hoặc câu chuyện rồi suy ra ý nghĩa thật. Transcript có thể mới chỉ là phần đầu video (sẽ có ghi chú); khi đó đừng bịa phần sau.

Trả về DUY NHẤT một JSON object, không Markdown, với các khóa:
- synopsis: tóm tắt nội dung bài giảng/cốt truyện, tiếng Việt, tối đa 80 từ.
- genre_tone: thể loại và giọng điệu (ví dụ: "Bài giảng kỹ thuật, học thuật, dễ hiểu" hoặc "Phim tâm lý, kịch tính"), tối đa 20 từ.
- characters: tối đa 15 NGƯỜI/NHÂN VẬT hoặc vai người nói (giảng viên, diễn giả, nhân vật...). Mỗi mục {"zh": tên hoặc vai trong lời thoại, "vi": tên/cách gọi tiếng Việt dùng khi dịch, "gender": "nam"|"nữ"|"?", "role": vai trò/chuyên môn, "calls": cách xưng hô điển hình}.
- terminology: object {"thuật ngữ gốc": "cách dịch tiếng Việt"}, tối đa 40 mục: khái niệm chính, thuật ngữ chuyên ngành, công nghệ, công thức, địa danh, tổ chức. Chọn nghĩa đúng theo bối cảnh chuyên ngành/câu chuyện.
- asr_fixes: object {"dạng nhận dạng sai": "dạng đúng"}, tối đa 30 mục (nếu có từ nghe nhầm hoặc viết sai).

Quy tắc:
- Tên người/địa danh Trung Quốc dùng âm Hán-Việt (曹→Tào), thuật ngữ tiếng Anh học thuật dịch chuẩn xác.
- Chỉ ghi điều có bằng chứng trong transcript; không bịa. Mục nào không chắc thì bỏ.
- Mỗi mục thật ngắn gọn."""

BIBLE_KEYS = ("synopsis", "genre_tone", "characters", "terminology", "asr_fixes")
BIBLE_CAPS = {"characters": 15, "terminology": 40, "asr_fixes": 30}
EMPTY_BIBLE_TEXT = "[STORY BIBLE]\n(chưa có)\n[HẾT STORY BIBLE]"


def _canon(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _json_object(content: str) -> dict:
    raw = (content or "").strip()
    raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.M).strip()
    return json.JSONDecoder().raw_decode(raw[raw.find("{") :])[0]


def _parse(content: str) -> dict[int, str]:
    data = _json_object(content)
    return {int(i["id"]): str(i["vi"]).strip() for i in data["items"] if str(i.get("vi", "")).strip()}


def _clean(text: str) -> str:
    """One line, and never end on a dangling comma: TTS would read it as an unfinished clause."""
    text = re.sub(r"\s+", " ", text).strip().strip("\"“”")
    text = re.sub(r"[,;:，；：、\s]+$", "", text)
    if text and text[-1].isalnum():
        text += "."
    return text


def _normalize_bible(data: dict) -> dict:
    out: dict = {}
    for key in BIBLE_KEYS:
        value = data.get(key)
        if key in ("synopsis", "genre_tone"):
            out[key] = str(value or "").strip()
        elif key == "characters":
            out[key] = [c for c in (value or []) if isinstance(c, dict)][: BIBLE_CAPS[key]]
        else:
            out[key] = dict(list(value.items())[: BIBLE_CAPS[key]]) if isinstance(value, dict) else {}
    return out


def _bible_message(bible: dict) -> str:
    return "[STORY BIBLE]\n" + _canon(bible) + "\n[HẾT STORY BIBLE]"


def _transcript_message(lines: list[tuple[float, str]], complete: bool, max_chars: int) -> str:
    body, used = [], 0
    for start, zh in lines:
        row = f"[{start:.1f}s] {zh}"
        if used + len(row) > max_chars:
            break
        body.append(row)
        used += len(row) + 1
    if len(body) < len(lines):
        note = f"(rút gọn: chỉ có {len(body)}/{len(lines)} câu đầu của video)"
    elif complete:
        note = "(toàn bộ video)"
    else:
        note = f"(mới đến giây {lines[-1][0]:.0f}; video còn tiếp)"
    return f"[TRANSCRIPT {note}]\n" + "\n".join(body) + "\n[HẾT TRANSCRIPT]"


class Translator:
    def __init__(self, s: Settings):
        from openai import OpenAI

        self.s = s
        self.client = OpenAI(base_url=s.base_url, api_key=s.api_key, timeout=60)
        self.history: list[tuple[str, str]] = []  # (zh, vi)
        self._lock = threading.Lock()
        self._bible_text = EMPTY_BIBLE_TEXT
        self._transcript_text = ""
        self.bible: dict = {}

    def understand(self, lines: list[tuple[float, str]], complete: bool) -> None:
        """Build the story bible from the SOURCE transcript. lines: [(start_sec, zh)] in time order."""
        if not lines:
            return
        transcript = _transcript_message(lines, complete, self.s.transcript_max_chars)
        messages = [
            {"role": "system", "content": UNDERSTAND_SYSTEM},
            {"role": "user", "content": transcript},
        ]
        bible = None
        for _ in range(3):
            try:
                r = self.client.chat.completions.create(model=self.s.model, messages=messages, max_tokens=6000)
                self._log_usage(r, "bible")
                bible = _normalize_bible(_json_object(r.choices[0].message.content))
                break
            except Exception as exc:
                print(f"[bible] retry: {exc}", flush=True)
        with self._lock:
            self._transcript_text = transcript  # the transcript helps even when the bible call failed
            if bible is not None:
                self.bible = bible
                self._bible_text = _bible_message(bible)
        if bible is not None:
            print(f"[bible] from {len(lines)} lines (complete={complete}): {len(bible['characters'])} characters, "
                  f"{len(bible['terminology'])} terms, {len(bible['asr_fixes'])} asr fixes", flush=True)

    def translate(self, segs: list[Seg], slots: list[float]) -> None:
        if not segs:
            return
        if all(bool(g.vi) for g in segs):
            for g in segs:
                self.history.append((g.zh, g.vi))
            return
        ctx = self.history[-self.s.context_pairs :]
        req = {
            "previous_lines": [{"zh": z, "vi": v} for z, v in ctx],
            "translate": [
                {"id": i, "zh": g.zh, "max_chars": max(12, int(slots[i] * self.s.chars_per_sec))}
                for i, g in enumerate(segs)
            ],
        }
        with self._lock:
            bible_text, transcript_text = self._bible_text, self._transcript_text
        messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": bible_text}]
        if transcript_text:
            messages.append({"role": "user", "content": transcript_text})
        messages.append({"role": "user", "content": json.dumps(req, ensure_ascii=False)})
        result: dict[int, str] = {}
        for _ in range(3):
            try:
                r = self.client.chat.completions.create(model=self.s.model, messages=messages, max_tokens=4000)
                self._log_usage(r, "translate")
                result = _parse(r.choices[0].message.content)
                if all(i in result for i in range(len(segs))):
                    break
            except Exception as exc:  # network / malformed JSON -> retry
                print(f"[translate] retry: {exc}", flush=True)
        for i, g in enumerate(segs):
            g.vi = _clean(result[i]) if i in result else g.zh
            self.history.append((g.zh, g.vi))

    @staticmethod
    def _log_usage(r, label: str) -> None:
        u = getattr(r, "usage", None)
        if u is None:
            return
        details = getattr(u, "prompt_tokens_details", None)
        cached = getattr(details, "cached_tokens", 0) or 0
        print(f"[{label}] prompt={u.prompt_tokens} cached={cached} completion={u.completion_tokens}", flush=True)
