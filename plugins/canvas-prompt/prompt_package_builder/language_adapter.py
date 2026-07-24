"""Language adapters for explicit speech acts used by deterministic inference.

These patterns identify what a speaker explicitly said. They never turn a
gesture, colour, or pause into an intent claim on their own.
"""

from __future__ import annotations

import re


PATTERN_SOURCES = {
    "negation": r"不太对|不准确|不合适|行不通|不成立|否定|不要|放弃|不做|不对|(?<!是)不是|that's not right|not correct|doesn't work|won't work|don't use|do not use|drop this|discard|not going with|won't do",
    "revision": r"应该|改为|改成|重写|更准确|最终版|换成|instead|change to|rewrite|replace(?: it)? with|more accurate|final wording",
    "confirmation": r"最终版本|最终.{0,2}结论|这是最终|就这个|确认|确定|这样更准确|这个.{0,8}想要的|简单.{0,8}有冲击力|this is final|final version|let's go with|we'll go with|that is the one|confirmed|this is what we want",
    "coexistence": r"可以组合|不互斥|不是互斥|有一定关系|可以并行|不冲突|can combine|not mutually exclusive|can coexist|in parallel|not in conflict",
    "selection": r"如果只能先选|优先级|优先.*选|倾向.*选|我.*会选|选择.*先|if we have to choose|priority is|i would choose|let's choose|pick .* first",
    "next_step": r"之后.*再|跑起来之后|下一步|再用|next step|after that|once .* then|then we can",
    "focus": r"最重要|比较重要|挺重要|这部分.*重要|这一层.*重要|重点是|关键是|most important|more important|the key is|the focus is|this part matters",
    "reframe": r"重新理解|重新看(?:一下)?|换个角度(?:看)?|重新想(?:一下)?|回到.*问题|rethink(?:ing)?|reframe|look at .* differently|step back|reconsider",
    "evaluation": r"太普通|没有差异|不够锋利|太技术|更准确|好了一点|too generic|not distinctive|not sharp enough|too technical|more accurate",
    "version": r"(?:第)?([一二三四1234])[版板]|v\s*([1234])|(?:the )?(first|second|third|fourth) version|version\s*([1234])",
}

# Speech-act rules remain intentionally shallow, but a question is not an
# assertion.  This guard is language-agnostic at the IR boundary and catches
# common Chinese and English interrogatives before any rule can promote them
# into a reject/confirm/selection event.
SPEECH_ACT_ADAPTER_VERSION = "speech-acts-v0.2"
QUESTION_MARK_RE = re.compile(r"[?？]")
ENGLISH_LEADING_QUESTION_RE = re.compile(
    r"^\s*(?:is|are|am|was|were|does|did|can|could|should|would|will|have|has|had)\b|"
    r"^\s*(?:isn't|aren't|don't|doesn't|didn't|won't)\s+(?:this|that|these|those|we|i|it|they|he|she)\b",
    re.IGNORECASE,
)
CHINESE_INTERROGATIVE_RE = re.compile(r"是不是|是否|能不能|要不要|可不可以|行不行|吗[。！!]?$|呢[。！!]?$")


def pattern(name: str) -> re.Pattern[str]:
    return re.compile(PATTERN_SOURCES[name], re.IGNORECASE)


NEGATION_RE = pattern("negation")
REVISION_RE = pattern("revision")
CONFIRM_RE = pattern("confirmation")
COEXISTENCE_RE = pattern("coexistence")
SELECTION_RE = pattern("selection")
NEXT_STEP_RE = pattern("next_step")
FOCUS_RE = pattern("focus")
REFRAME_RE = pattern("reframe")
EVALUATION_RE = pattern("evaluation")
VERSION_RE = pattern("version")
ITERATIVE_RE = re.compile(
    rf"(?:{PATTERN_SOURCES['version']}).*(?:{PATTERN_SOURCES['evaluation']})|(?:{PATTERN_SOURCES['evaluation']}).*(?:{PATTERN_SOURCES['version']})",
    re.IGNORECASE,
)


def is_interrogative(text: str) -> bool:
    """Whether a caption asks rather than explicitly asserts a speech act."""
    return bool(
        QUESTION_MARK_RE.search(text)
        or ENGLISH_LEADING_QUESTION_RE.search(text)
        or CHINESE_INTERROGATIVE_RE.search(text)
    )

