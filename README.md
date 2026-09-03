# pi-guru

pi-guru is an extension for the pi coding agent that sits between the agent and the computer. Before any change to the computer, it asks you, and you can ask what the change means before it happens. Reads are never blocked; they are narrated afterwards so you can follow along.

It’s a way to learn what the agent is doing, and to come to trust the process as you go. It's one package, one extension entry point.

## Quick start

```
pi install git:github.com/jesseslone/pi-guru
```

Then start pi as usual. The next time the agent wants to change something, the gate appears with Explain selected; press Enter to read what the change does, then choose Approve or Deny. Two commands to know from the start:

```
/explain-level fundamental    # plainest explanations; intermediate is the default
/judge advise                 # the default: a second opinion on every change, shown above the gate
```

Works with any model you have configured in pi. The content checks ship prebuilt parsers for macOS arm64 and Linux x64; on other platforms they stand down and everything else keeps working.

## Why it exists

I teach people to bring coding agents into their work. To help them learn to work with these new tools, I wanted a way to be transparent about what the agent was doing, and a chance to learn from it as you go. I looked for something that already did that, but found nothing.

As far as prior art, I couldn't find any pi extension that had an Explain choice. There are several open-source tools that provide gates and AI judges, and I borrowed two pieces from those projects, with attribution: the bash wrapper detection from @gotgenes/pi-permission-system and the hard-deny seed list from czottmann/pi-automode, both MIT.

## Hard denies

Every call to make a change runs through several checks: session allows, the judge, and the gate. But before any of those checks are reached, pi-guru checks a short list of hard denies.

Hard denies are the same for everyone and don't require any approval or special mode, and there's no way to override them. The list is small and deliberate: the hard-denied commands are the ones that would delete the home folder or the root of the disk; shell start-up files; the keys that grant remote login; scheduled hidden jobs; turning off certificate checks; and pi-guru's own configuration.

The hard-denies list is a tripwire, not a net. It's intended to protect against some of the most obvious mistakes. The gate and the person are the real safeguard, and the person can still approve a bad change.

If pi-guru can't read a command well enough to understand it, it asks rather than guessing.

## The gate

The gate is written for you, the person watching the agent, not for the agent itself. A change call is any tool call that can change something on the computer, like a bash command or a file write or a file edit or any tool call that pi doesn't know is read-only. Before a change call runs, the gate appears and offers five choices: explain, approve, approve for this session, deny, and deny with a reason.

Explain is the default and pressing enter explains the command before it runs. Approve for this session remembers the word of the command, like git or npm or the directory that's being written to, so it doesn't ask the same question every time and the interruptions taper off as you gain trust. And deny with a reason sends the reason back to the agent, which gives it a chance to adjust its approach rather than guessing again.

### What the gate looks like

A real gate, captured from a session at the intermediate level, before and after pressing Enter on Explain:

```
Run this command?
mkdir -p build && cp existing.txt build/ && ls -la build
→ Explain                         Plain-language account (intermediate)
  Approve                         Run this once
  Approve for this session        Remember and stop asking
  Deny                            Do not run it
  Deny with a reason              Tell the agent why
↑↓ navigate • enter select • esc deny
```

```
Run this command?
mkdir -p build && cp existing.txt build/ && ls -la build
Explanation (intermediate):
This action creates a new folder named "build" if it doesn't already exist, copies an
existing file named "existing.txt" into that folder, and then lists the contents of the
"build" folder to show what is inside. It is used to organize files into a dedicated
directory and verify the copy was successful. The main risk is if "existing.txt" does not
exist, which would cause an error when trying to copy it, potentially stopping the rest of
the command from running.

Commands and flags
- mkdir: Creates a new directory.
- -p: Ensures parent directories are created if needed and does not error if the directory already exists.
- cp: Copies source files or directories to a destination.
- ls: Lists directory contents.
- -la: Shows detailed information about all files, including hidden ones.
  Explain                         Plain-language account (intermediate)
→ Approve                         Run this once
  Approve for this session        Remember and stop asking
  Deny                            Do not run it
  Deny with a reason              Tell the agent why
```

With the judge in advise mode, its verdict sits above the question:

```
[LOW RISK] Copying a file and listing directory contents are routine, local, and easily reversible operations.
Run this command?
cp existing.txt backup.txt && ls -la
→ Explain                         Plain-language account (intermediate)
  ...
```

## Explanation levels

There are four explanation levels: *fundamental*, *intermediate*, *technical*, and *off*. A fresh install starts at *intermediate*. At *fundamental* level, no command-line background is assumed. It avoids jargon, tells you what will change, what it's for, and what could go wrong if you make the change. *Intermediate* adds a short list naming each command and flag and what it does, so you can build your vocabulary. *Technical* is a terse expert summary. *Off* means no *Explain* choice on the gate, and no narration.

You can choose the level you prefer with the /explain-level command, for example, /explain-level fundamental. This persists between sessions. If you ever want to step up one level, you can choose *Explain* again on the same gate. That steps one level deeper for that one call without changing the setting.

The session model writes explanations for commands it has not yet run. The prompt forbids inventing details, but a wrong explanation is possible.

### Commands

| Command | What it does |
|---|---|
| `/explain-level` | Show the current level. |
| `/explain-level fundamental` | Set the level: `fundamental`, `intermediate`, `technical`, or `off`. `/explain` is an alias. |
| `/judge` | Show the judge mode, threshold, and this session's counts. |
| `/judge advise` | Judge rates every change call; a person still decides. |
| `/judge auto medium` | Judge may approve up to `low` or `medium` risk on your behalf. `/judge off` turns it off. |
| `/gate` | List this session's allows. `/gate clear` forgets them. |
| `/judge-bench run [provider/model] [--passes 3] [--prompt v2] [--facts off]` | Benchmark the judge on the configured model; results stay on this machine. |
| `/judge-bench compare`, `show <run>`, `diff <a> <b>`, `rescore <run>` | Compare, inspect, and re-read prior runs. |

## Narration

Narration is what the person sees for read calls: reading a file, searching the project, listing a folder. A read call never stops the agent. At the end of each turn, pi-guru writes one plain-language account of what the agent looked at and why, at the current level. The why comes from the agent's own words for that turn; if it gave none, the account says so rather than supplying one. When the read commands are familiar, the person turns the level down or off.

## The judge

The judge is an optional second opinion that provides a quick risk assessment for every change call. It is a separate model call that rates the risk of each change call as low, medium, or high, along with a one-line rationale for that rating.

The judge has three modes: **off**, **advise**, and **auto**. By default it advises, and you can change that with the `/judge` command.

In **advise** mode, the verdict and rationale appear on the gate, but you still always have the final say. This lets you use the judge to help you decide when you're learning how the agent works.

In **auto** mode, the judge can approve changes on your behalf up to an autonomy threshold you set (low or medium). High-risk changes always require your approval, even in auto mode. The threshold starts at low; medium is the most the judge may ever approve on its own.

The judge is a second opinion from the same kind of model that is writing the commands, so it can be wrong in the same direction, and your attention still carries the decision. When the judge approves a change, the rationale still appears on the gate, so you can still learn from it.

## The benchmark

The benchmark tool is included with pi-guru, and can be run from within a pi session with /judge-bench. It replays labelled tool calls from a selection of open datasets through the exact prompt and parser used in production, on any model configured in pi. For each source, it reports:
* how often harmful tool calls were rated low enough to pass the judge,
* how often benign tool calls were rated high and blocked,
* how often the model changed its verdict after three or nine repeated passes.

Before the judge is reached, pi-guru also checks the call itself (credential reads, network into a shell, system paths, sudo, eval), and shows both the judge and the person what it found. Some of these checks will set a floor that the verdict cannot fall below.

All results are stored on the local machine, and /judge-bench compare can line up runs of different models, prompts, and settings over time. There's also a plain-language reading at the current level, which explains what the numbers mean and what they don't.

Data is fetched at run time and cached locally, it is never shipped out of the machine. The sources are RedCode-Exec (CC-BY-4.0), rogue-security's coding-agent security benchmark (CC-BY-NC-4.0), and pi-guru's own hand-written cases; two unlicensed sources are off by default.

The benchmark is a comparison between runs on the same records. It is not a certificate. The sample sizes, per source, are small, and one source labels code quality rather than danger to the machine.

## When no one is there

When the agent is running in a context with no person present, such as scripted mode or a subagent, the agent is prevented from making changes. Rather than allowing a change call, a stop handoff is written to disk.

A stop handoff is a short file in the project that notes what was attempted, why it was stopped, and what the person should do next. The agent then exits.

If the judge is in auto mode, it may still approve changes within the autonomy threshold. Nothing is ever allowed silently.

If you launch pi headless inside a sandbox of your own, tell pi-guru so, and it stands aside for that run while keeping its hard denies:

```
PI_GURU_SANDBOXED=1 sandbox-exec -f .sandbox.sb pi -p "..."
```

Linux containers are recognised on their own; a macOS seatbelt sandbox is not, so the variable is the contract there.

## What it uses

- Everything that pi-guru does on its own is done with the same model that the pi session is already using. No separate key, account, or service is required.

- The cost is simply a few extra calls on that model:
  - Explain is one call for each time it is pressed.
  - Narration is one call for each turn that reads something.
  - The judge is one call for each change call while it is on.
  - A session with the level off and the judge off adds no calls at all.

- The explanations, narration, and verdicts never enter the agent’s own context, so the agent behaves the same. The only exception is a denial reason, which is sent to the agent on purpose.

## Installing

```
# from GitHub
pi install git:github.com/jesseslone/pi-guru

# from a local clone
pi install /path/to/pi-guru

# for this project only, written to .pi/settings.json instead of your user settings
pi install -l /path/to/pi-guru

# try it once without installing
pi -e /path/to/pi-guru/extensions/pi-guru.ts
```

### Configuration

`~/.pi/agent/pi-guru.json`, with every key at its default. Set `PI_GURU_CONFIG` to point at a different file.

```json
{
  "level": "intermediate",
  "judgeMode": "advise",
  "judgeThreshold": "low",
  "judgeLayout": "current",
  "judgePrompt": "v1",
  "judgeFacts": true,
  "readOnlyTools": [],
  "hardDeny": []
}
```

| Key | Values | Meaning |
|---|---|---|
| `level` | `fundamental`, `intermediate`, `technical`, `off` | Depth of Explain and narration. |
| `judgeMode` | `off`, `advise`, `auto` | Whether the judge runs, and whether it may approve. |
| `judgeThreshold` | `low`, `medium` | In auto mode, the highest risk the judge may approve. |
| `judgeLayout` | `current`, `prefix-stable`, `shared-prefix` | How the judge request is laid out; `current` unless you are measuring cache reuse. |
| `judgePrompt` | `v1`, `v2` | Which judge prompt to use. `v2` catches more at the low threshold; see the benchmark notes. |
| `judgeFacts` | `true`, `false` | Whether the deterministic checks run before the judge and set floors. |
| `readOnlyTools` | tool names | Extra tools treated as reads and never gated. `bash`, `write`, and `edit` are refused here. |
| `hardDeny` | regex strings | Extra hard-deny rules, added to the built-in list. |

A project may add `.pi/pi-guru.json`, read only once you have trusted the project. It can only tighten: shrink `readOnlyTools`, add `hardDeny` rules, lower the judge mode or threshold. It cannot change `level`.
