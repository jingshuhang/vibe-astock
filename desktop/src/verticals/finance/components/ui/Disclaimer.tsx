import { Info } from "lucide-react";
import { PRODUCT_NAME } from "@/lib/brand";

// 说明条 —— Agent 负责流程与校验、模型负责推理;产品提供研究结论,由使用者自行决断。
export function Disclaimer({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <p className="text-[11px] leading-relaxed text-muted-foreground/70">
        {PRODUCT_NAME} 客观呈现公开数据与榜单,可提供参考性研究结论(买卖参考、估值锚、目标价区间、止损位等),是否采纳由使用者自行决断。
      </p>
    );
  }
  return (
    <div className="mt-8 flex items-start gap-2 rounded-lg border border-border/60 bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        {PRODUCT_NAME} 在本机组织公开数据、运行研究工具并校验证据,所选 AI 模型负责推理。榜单(连板股 / 成交额等)均为<b className="text-foreground">客观公开数据</b>;产品可给出参考性研究结论(买卖参考、估值锚、目标价区间、止损位等),但须明确标注为参考并说明依据。**最终是否采纳、如何决策由使用者自行判断**,模型输出可能出错,请沿证据链自行核实。
      </span>
    </div>
  );
}
