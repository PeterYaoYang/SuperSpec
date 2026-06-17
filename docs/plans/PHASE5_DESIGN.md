# SuperSpec 流程引擎 — 技能适配层

## 状态
- 日期：2026-06-18
- 范围：Phase 5 — 技能适配层（agent 循环驱动）

## 设计

技能不再携带协议真相。所有工作流技能退化为一个薄适配循环：

```
run superspec transition next --change X
execute returned next_command / job packet
record result
repeat
```

## 实现

### skill-loop.sh

一个通用的 shell 脚本，agent 可以调用：

```bash
#!/usr/bin/env bash
# superspec skill-loop — 薄适配循环
# 用法：skill-loop.sh <change>

CHANGE="${1:?需要 change 名}"
PROJECT_ROOT="$(pwd)"

while true; do
  # 1. 跑 next
  RESULT=$(superspec transition next --change "$CHANGE" --format json 2>/dev/null)
  if [ $? -ne 0 ]; then
    echo "next 命令失败"
    exit 1
  fi

  # 2. 解析 path
  PATH_TYPE=$(echo "$RESULT" | jq -r '.path')
  STATE=$(echo "$RESULT" | jq -r '.state')

  case "$PATH_TYPE" in
    "done")
      echo "流程完成：$STATE"
      break
      ;;
    "next_command")
      CMD=$(echo "$RESULT" | jq -r '.next_command')
      echo "执行: $CMD"
      eval "$CMD"
      ;;
    "required_job")
      JOBS=$(echo "$RESULT" | jq -r '.required_jobs[].packet_command')
      for JOB_CMD in $JOBS; do
        echo "执行工作项: $JOB_CMD"
        eval "$JOB_CMD"
        # agent 读 packet → 干活 → record job-submit
        echo "（agent 完成工作项后 record job-submit，然后继续循环）"
      done
      ;;
    "ask_user")
      QUESTION=$(echo "$RESULT" | jq -r '.ask_user.question')
      echo "需要用户确认: $QUESTION"
      # 等待用户处理（实际 agent 会暂停并呈递给用户）
      break
      ;;
    *)
      echo "未知 path: $PATH_TYPE"
      break
      ;;
  esac

  # 简单防无限循环
  sleep 0.1
done
```

### 技能文件（5 个，全部退化为引用循环）

每个技能文件极简化：

```markdown
# superspec-{stage}

调用 superspec transition next --change <change> 获取下一步命令。
执行返回的命令。登记结果。重复。
```

### 测试

验证 skill-loop 的核心逻辑：next 返回 done 时停止。
