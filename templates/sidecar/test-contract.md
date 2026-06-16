<!-- SuperSpec sidecar：写入 openspec/changes/<change>/.superspec/artifacts/test-contract.md
     不是 OpenSpec artifact，不进 openspec status graph。 -->

## 测试覆盖矩阵

| TEST-ID | 关联 REQ/Scenario | 关联 INV | 维度 | 测试意图（断言什么行为） | 预期 RED 原因 |
|---|---|---|---|---|---|
| TEST-001 | <REQ-xxx / Scenario 名> | INV-xxx | 正常路径 |  |  |

## 红绿灯契约

### TEST-001
- `invariant_refs`: INV-xxx
- `expected_red`: <实现前因何失败>
- `expected_green`: <实现后通过的判据>
- `test_command`: <framework-agnostic command that runs exactly the target test identity>

## Iron Law

- 没有正在失败的测试，不准写实现代码。
- 每个实现型 task：先有 RED evidence 才能改实现代码，先有 GREEN evidence 才能勾选。
- 测试证据语义（框架无关）：`target test identity executed` 才算有效运行；`command exit code alone is not proof`，退出码 0 不等于目标测试跑过/通过；命令在到达测试 runner 之前失败属于 `blocked before the target test runner`，不是 RED/GREEN；`do not classify environment/build failures as RED or GREEN`。

## 与 tasks 的映射约定

<!-- 每个 TEST-ID 必须在 tasks.md 至少一个 task 的 test_refs 中出现；guard 交叉校验。 -->
<!-- 每个 hard INV-ID 必须在 test-contract.md 至少一个 TEST-ID 的 关联 INV 中出现，并在 tasks.md 至少一个 task 的 invariant_refs 中出现。 -->
