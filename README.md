# AI Project

This project is configured with the **Everything Claude Code (ECC) Developer Suite** adapted natively for **Google Antigravity 2.0**.

## 🛠 Project Environment & Architecture

- **Root Location**: `D:\AI Project`
- **Agent System**: Antigravity 2.0 Native (`.agents/`)
- **ECC Target**: `antigravity-project`
- **Installed Components**:
  - **71 Agents** in [`.agents/agents/`](.agents/agents) (Specialized for architecture, code review, TDD, security, debugging, etc.)
  - **122 Rules** in [`.agents/rules/`](.agents/rules) (TypeScript, testing, coding standards, orchestration, and database conventions)
  - **97 Workflows** in [`.agents/workflows/`](.agents/workflows) (Slash commands runnable directly in Antigravity)
  - **132 Skills** in [`.agents/skills/`](.agents/skills) (TDD, strategic compaction, quality gates, living docs, unified memory, etc.)

---

## 🚀 How to Use ECC with Antigravity

### 1. Workflows (Slash Commands)
You can invoke any installed workflow directly in the conversation prompt by typing its slash command:
- `/plan` - Interactive structured planning before starting complex implementation
- `/review` - Comprehensive multi-perspective code review
- `/tdd` - Test-Driven Development loop (red-green-refactor)
- `/security` - Threat modeling, vulnerability scanning, and secure coding review
- `/debug` - Systematic root-cause debugging and verification
- `/e2e` - End-to-end and integration test orchestration

### 2. Specialized Agents & Subagents
Antigravity automatically detects custom agents defined in [`.agents/agents/`](.agents/agents). Examples include:
- `code-reviewer` - Thorough code quality and architectural compliance reviewer
- `architect` - System architecture, schema design, and boundary analysis
- `security-auditor` - Static analysis, credential scan, and auth logic auditor
- `test-engineer` - Unit, integration, and property-based test generator

### 3. Rules & Standards
Rules in [`.agents/rules/`](.agents/rules) are actively respected by Antigravity across sessions, covering:
- TypeScript strict typing, error handling, and clean code
- API design and backend structure
- Git commit conventions and branching workflows
- Database schemas, migrations, and query best practices

---

## 🔍 Health & Verification

To verify or repair the ECC installation at any time, run from the project root:

```powershell
node "C:\Users\yarra\.gemini\antigravity\scratch\ecc\scripts\doctor.js" --target antigravity
```
