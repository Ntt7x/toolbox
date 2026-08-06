// ============================================================
// 康复笔记：默认种子数据（工厂默认值，幂等 seed 到 KV，不覆盖用户编辑）
// 来源：DeepSeek 分享对话（医疗经验 h7pskfylfsr1eenwlq / 肌肉训练 ge03hwztzri0wqkcwm）
// ============================================================

import type { RehabNote } from "@toolbox/shared";

const item = (name: string, detail: string) => ({ name, detail });
const plain = (detail: string) => ({ detail });

/** 康复/医疗经验（后新冠时期感冒治疗方案 + SIBO 方案） */
export const MEDICAL_SEED: RehabNote = {
  id: "medical",
  title: "后新冠时期感冒治疗方案 + SIBO 方案",
  updatedAt: new Date().toISOString(),
  sections: [
    {
      title: "1. 疾病初发",
      items: [
        item("喉咙痛", "甘草汤 → 桔梗甘草汤 → 玄麦甘桔汤 → 麻黄附子细辛汤"),
        item("怕冷自汗", "桂枝汤"),
        item("发热大咳", "桂枝汤加厚朴杏仁白术"),
      ],
    },
    {
      title: "2. 疾病三四日",
      items: [
        item("胃口差/肋下不适", "小柴胡汤"),
        item("支持-代谢神经", "复合VB"),
        item("支持-抗炎抗敏", "大剂量VC"),
        item("支持-黏膜屏障", "复合VAD"),
        item("分化-干咳不止", "麦门冬汤"),
        item("分化-脑雾疲劳", "黄芪当归四逆汤"),
        item("分化-清涕不止", "小青龙汤合四逆汤 → 过敏煎"),
      ],
    },
    {
      title: "3. 炎症消退后",
      items: [
        item("腹胀", "厚朴生姜半夏甘草人参汤 → 理中丸 → 陈夏六君丸 → 香砂六君丸"),
        item("但欲睡", "四逆汤"),
        item("过敏/半夜瘙痒", "乌梅丸"),
        item("病后余咳", "桔梗玄参汤"),
        item("病后夜热", "小建中汤 → 炙甘草汤 → 金匮肾气丸（先建中养阴，后温固命门）"),
      ],
    },
    {
      title: "SIBO 食谱（低发酵、易吸收）",
      items: [
        item("碳水", "葡萄糖、白米饭（单糖/快吸收，减少细菌底物）"),
        item("蛋白质", "蛋白/蛋清（无纤维、无抗原）"),
        item("脂肪", "中链甘油三酯（MCT）/椰子油、少量蛋黄（直接供能不依赖胆汁）"),
        item("蔬菜", "叶菜（菠菜/生菜）、瓜类（冬瓜/黄瓜）——低 FODMAP"),
      ],
    },
    {
      title: "SIBO 药物",
      items: [
        item("基础支持", "复合VB + VAD + 中剂量VC（缓释 1-2g/日 分服，抗炎修复肠漏）"),
        item("核心合方", "半剂香砂六君子汤 + 半剂乌梅丸（1:1 合煎）"),
        item("促排空", "生白术 30g + 枳壳 10g（融入合方），或餐间嚼服生姜片"),
        item("疗程", "守 4-6 周，待腹鸣/腹胀减退后逐步回添可溶性纤维（南瓜/胡萝卜），最后以理中丸善后"),
      ],
    },
  ],
};

export const REHAB_SEEDS: Record<string, RehabNote> = {
  medical: MEDICAL_SEED,
};
