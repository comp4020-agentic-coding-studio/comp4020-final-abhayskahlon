# Research Note: Bounded Autonomy in Agentic Software Development

## Introduction

Agentic AI systems can plan tasks, use development tools, modify code and respond to execution feedback. Their growing capability raises a question: how much authority should developers delegate? I argue for bounded, risk-proportionate autonomy. Agents should work independently on clearly specified, reversible tasks, while their permissions narrow as the potential impact of an error increases. The aim is neither approval of every edit nor maximum autonomy, but deliberate delegation with human responsibility retained.

## The case for delegation

There are strong reasons to give agents meaningful independence. Yang et al. (2024) show that SWE-agent's purpose-built agent-computer interface enables a language model to navigate repositories, edit files and run tests. Using GPT-4 Turbo, it resolved 12.47% of 2,294 SWE-bench tasks. The HumanEvalFix results require more careful interpretation: the abstract's 87.7% figure is identical to Table 2's Python-specific score, while the Results section reports 88.3% as an aggregate without explicitly explaining its derivation. More importantly, these benchmarks test different capabilities. SWE-bench evaluates issue resolution across real repositories, whereas HumanEvalFix evaluates short-form code debugging. Their scores should not be treated as equivalent measures of general software-engineering reliability. SWE-agent demonstrates meaningful autonomous coding capability, but benchmark performance alone does not establish reliability in production development.

Anthropic's practitioner account, Building Effective Agents (2024), makes a complementary argument. It recommends the simplest architecture that meets the task's needs, distinguishing predictable workflows from agents that need flexibility to determine their own steps. It also warns that autonomous agents can compound errors and recommends sandboxed testing and guardrails. This is valuable practical guidance, but it is vendor-authored rather than a controlled comparative study. Read together, these sources support delegation where flexibility adds value, not autonomy for its own sake.

## Why autonomy needs boundaries

An agent can complete a literal task while violating its intent, overlooking an architectural constraint or introducing defects outside the tested path. Passing tests is evidence about the cases tested, not proof that a change is safe in every context. Parasuraman, Sheridan and Wickens (2000) offer a useful framework: automation can operate at different levels across information acquisition, analysis, decision selection and action implementation. Although their model predates LLM agents, its central insight remains useful: automation is not all-or-nothing. Developers might automate code search and test execution while retaining authority over requirements, security-sensitive decisions and release approval.

Amershi et al. (2019) propose human-AI interaction guidelines that emphasise communicating system capabilities, making behaviour understandable and supporting correction. Their study concerns AI-infused products generally, not coding agents specifically, so it cannot prescribe software-engineering controls directly. It nevertheless reinforces the importance of visibility and recoverability when people rely on AI outputs.

## A risk-proportionate boundary

Autonomy should depend on three factors: impact, reversibility and permission scope. Low-impact, easily reversible work, such as editing an isolated component, running tests or proposing a refactor, can proceed within an agreed task without repeated approval. Changes with broader consequences, such as database migrations or shared architectural changes, warrant review, backups and explicit acceptance criteria. Actions affecting authentication, access controls, secrets, production data or deployment should require narrowly scoped permissions and human approval before execution. If requirements are ambiguous, the agent should stop and ask rather than invent policy.

This approach is consistent with the 2026 joint guidance Careful Adoption of Agentic AI Services, co-authored by the Australian Cyber Security Centre and partner agencies. It recommends beginning with low-risk tasks, applying least-privilege access, defining explicit control flows, monitoring behaviour and retaining human approval for high-impact actions. The guidance focuses on organisational security rather than software quality as a whole, but it supplies concrete mechanisms for implementing bounded autonomy.

## Counterargument and conclusion

A reasonable objection is that human checkpoints create bottlenecks and erase the productivity gains of agents. This is true when approval is demanded for every routine action. Bounded autonomy does not require constant supervision: permissions are established in advance, and escalation occurs when a task crosses a risk boundary, becomes ambiguous or affects a consequential system.

Good agentic development is therefore neither unrestricted delegation nor human micromanagement. It is the deliberate allocation of autonomy: agents should carry out bounded implementation work, while developers retain authority over objectives, high-impact decisions and acceptance of results. Progress should be measured not by how rarely a human intervenes, but by whether the system makes reliable progress while keeping its actions understandable, constrained and recoverable.

## References

- Amershi, S. et al. (2019). "Guidelines for Human-AI Interaction." Proceedings of the 2019 CHI Conference on Human Factors in Computing Systems. https://doi.org/10.1145/3290605.3300233
- Anthropic (2024). "Building Effective Agents." https://www.anthropic.com/research/building-effective-agents
- Australian Signals Directorate's Australian Cyber Security Centre, CISA, NSA, Canadian Centre for Cyber Security, New Zealand NCSC and UK NCSC (2026). Careful adoption of agentic AI services. https://www.cyber.gov.au/publication/careful-adoption-of-agentic-ai-services
- Parasuraman, R., Sheridan, T. B. & Wickens, C. D. (2000). "A Model for Types and Levels of Human Interaction with Automation." IEEE Transactions on Systems, Man, and Cybernetics—Part A: Systems and Humans, 30(3), 286–297. https://doi.org/10.1109/3468.844354
- Yang, J. et al. (2024). "SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering." Advances in Neural Information Processing Systems 37. https://doi.org/10.52202/079017-1601
