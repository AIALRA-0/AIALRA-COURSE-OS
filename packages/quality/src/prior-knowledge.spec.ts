import { describe, expect, it } from "vitest";
import { parsePriorKnowledgeDefinitions } from "./prior-knowledge.js";

describe("parsePriorKnowledgeDefinitions", () => {
  it("flattens mixed definitions and merges an explicit heading with its description without inventing a name", () => {
    expect(parsePriorKnowledgeDefinitions("节点（Node）：图中的对象；正文里有：标点，不能拆。\n- 边（Edge）：连接对象。\n## Kernel\n  用来计算对象之间的关系。\n- 路径（Path）：有序连接。"))
      .toEqual(["节点（Node）：图中的对象；正文里有：标点，不能拆。", "边（Edge）：连接对象。", "Kernel： 用来计算对象之间的关系。", "路径（Path）：有序连接。"]);
  });

  it("merges explicit continuation items into their preceding term as a continuous definition", () => {
    expect(parsePriorKnowledgeDefinitions([
      "节点（Node）：图中的对象。",
      "它工作的方式是：保存相邻对象。",
      "边（Edge）：连接两个对象。\n\n它工作的方式是：\n标记连接两端。",
      "它工作的方式是：保留连接关系。"
    ])).toEqual(["节点（Node）：图中的对象。 它工作的方式是：保存相邻对象。", "边（Edge）：连接两个对象。 它工作的方式是： 标记连接两端。 它工作的方式是：保留连接关系。"]);
  });

  it("does not infer terms from prose colons or split arbitrary sentences, nor truncate after eight definitions", () => {
    expect(parsePriorKnowledgeDefinitions(["正文说明：它不是一个词条。；还有一句。", "还需要检查：这个条件。"])).toEqual(["正文说明：它不是一个词条。；还有一句。", "还需要检查：这个条件。"]);
    const terms = Array.from({ length: 12 }, (_, i) => `对象${i}（Object${i}）：定义${i}。`);
    expect(parsePriorKnowledgeDefinitions(terms.join("\n- "))).toEqual(terms);
  });

  it("retains ambiguous independent items and a leading continuation without deleting them", () => {
    expect(parsePriorKnowledgeDefinitions(["它工作的方式是：前文缺失仍应展示。", "节点（Node）：一个对象。", "向量与矩阵乘法：此独立旧词条没有英文标签。", "没有显式词条形状的旧知识。"]))
      .toEqual(["它工作的方式是：前文缺失仍应展示。", "节点（Node）：一个对象。", "向量与矩阵乘法：此独立旧词条没有英文标签。", "没有显式词条形状的旧知识。"]);
  });

  it("protects quoted definitions, genuine nested references, code, display math and inline objects", () => {
    const objects = [
      "- 引用：\n  - 术语（Quoted Term）：保留真实子列表。",
      "> - 对象（Quoted Object）：保留引文。\n> 第二行引文。",
      "````md\n## Fake\n- 错误（Fake）：代码原文。\n```\n````",
      "$$\nA:\n- 系数（Coefficient）：公式原文。\n$$",
      "\\[\n- 系数（Coefficient）：旧公式原文。\n\\]",
      "`- 术语（Term）：行内代码。` 与 $x:y$ 和 \\(a:b\\) 保留。"
    ];
    const result = parsePriorKnowledgeDefinitions(`节点（Node）：定义。\n\n${objects.join("\n\n")}\n\n- 边（Edge）：另一条定义。`);
    expect(result).toHaveLength(2);
    for (const object of objects) expect(result[0]).toContain(object);
    expect(result[1]).toBe("边（Edge）：另一条定义。");
  });

  it("protects multiline inline code and legacy inline math against false term boundaries", () => {
    for (const object of ["`raw\n- 假名（Fake）：仍在代码里。\nraw`", "\\(\nx:\n- 假名（Fake）：仍在公式里。\n\\)"]) {
      const result = parsePriorKnowledgeDefinitions(`节点（Node）：定义。\n${object}\n- 边（Edge）：下一项。`);
      expect(result).toHaveLength(2);
      expect(result[0]).toContain(object);
    }
  });

  it("is idempotent and preserves bilingual punctuation and original heading names", () => {
    const source = ["**多层模型（MLM，Multi-Layer Model）：** 原有标点。\n\n正文保持同一块。", "## 原有函数名\n原有说明。", "它工作的方式是：延续上一项。"];
    const result = parsePriorKnowledgeDefinitions(source);
    expect(result[1]).toBe("原有函数名： 原有说明。 它工作的方式是：延续上一项。");
    expect(parsePriorKnowledgeDefinitions(result)).toEqual(result);
  });
});
