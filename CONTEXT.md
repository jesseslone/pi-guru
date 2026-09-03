# pi-guru

Extensions that let anyone supervising pi-coding-agent learn what it is doing and trust the process as they go: a gate on tool calls that change things, plain-language explanations on demand, and an AI judge that can approve on the person's behalf.

## Language

**Change call**:
A tool call that can alter state: bash, write, edit, and any tool not known to be read-only. Change calls are gated.
_Avoid_: mutating call, dangerous command, risky command

**Read call**:
A tool call that only inspects: read, grep, find, ls, and tools known to be read-only. Read calls are never gated; they are narrated.
_Avoid_: safe command, query

**Gate**:
The approval prompt shown before a change call runs. Offers Explain, Approve, Approve for this session, Deny, and Deny with a reason. Explain is the default unless the explanation level is off.
_Avoid_: permission popup, confirm dialog

**Session allow**:
A remembered approval that lets later change calls with the same command word, or writes in the same directory, pass the gate for the rest of the session.
_Avoid_: whitelist, always allow, trust

**Explanation**:
The plain-language account the session model gives, on request from a gate, of what a change call will do. Its depth is set by the explanation level.
_Avoid_: rationale (reserved for the judge's reasoning), description

**Explanation level**:
One of fundamental, intermediate, technical, or off. Fundamental assumes no command-line background. Intermediate also names and teaches each command and flag. Technical is a terse expert summary. Off hides explanations.
_Avoid_: verbosity, detail level, plain/guided

**Narration**:
A plain-language account of the read calls made during one turn, what each looked at and why, produced once per turn without stopping the agent. Can be switched off once the person knows the read commands.
_Avoid_: explanation (reserved for the Explain choice on a gate), log line

## Judge

**Judge**:
A model call, on the session model with its own system prompt over the transcript, that rates a change call before the gate. Advise by default.
_Avoid_: classifier, auto mode, guardian, reviewer

**Judge mode**:
One of off, advise, or auto. In advise the judge's verdict and rationale appear on the gate and a person always decides. In auto the judge may approve on the person's behalf, up to the autonomy threshold.
_Avoid_: yolo, unattended

**Verdict**:
The judge's rating of a change call: its risk level and a one-line rationale.
_Avoid_: decision (reserved for what the person chooses), outcome

**Risk level**:
The judge's rating of a change call as low, medium, or high. High-risk calls always reach the gate.
_Avoid_: severity, danger score

**Autonomy threshold**:
In auto judge mode, the highest risk level the judge may approve on the person's behalf: low or medium.
_Avoid_: trust level, confidence

**Rationale**:
The judge's one-line reason for its verdict, written at the current explanation level.
_Avoid_: explanation (reserved for the Explain choice)

**Stop handoff**:
A written note the extension leaves when it blocks a change call with no person present: what was attempted, why it was stopped, and what a person should do next. Written whenever the agent is stopped for a dangerous call, so unattended work never ends silently.
_Avoid_: error log, crash report

**Hard deny**:
A deterministic rule that blocks a change call before the judge sees it and that no judge mode or session allow can override.
_Avoid_: blocklist, blacklist

## Assessor

**Assessor**:
A deterministic pass over a change call, run before the judge, that produces facts and possibly a floor. It parses; it never guesses.
_Avoid_: scanner, linter, classifier

**Fact**:
A neutral, verified statement about a change call, such as "reads ~/.ssh/id_rsa" or "pipes a network download into a shell". Facts are shown to the judge and to the person as things pi-guru checked, not opinions.
_Avoid_: finding, alert, flag

**Floor**:
The minimum risk a fact imposes on a verdict. The judge's rating is raised to the floor, never lowered, and the verdict records which fact raised it.
_Avoid_: override, hard rule, boost

**Unresolved command**:
A command the assessor could not reduce to literal words, because of substitution, an unlisted wrapper, or a variable in the command position. Being unresolved is itself a fact, and an unresolved command always gates.
_Avoid_: unparseable, unknown command

