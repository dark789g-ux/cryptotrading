import { FileText, TrendingUp, AlertTriangle, Zap, Target, Newspaper, ChevronRight } from 'lucide-react';

const topSectors = [
  { name: '工业气体', pct_chg: 7.23 },
  { name: '半导体材料与设备', pct_chg: 6.59 },
  { name: '石油天然气储运', pct_chg: 6.34 },
  { name: '电脑硬件/储存', pct_chg: 5.97 },
  { name: '半导体产品', pct_chg: 5.16 },
];

const topInflow = [
  { name: 'DR寒武纪', net: '+39.83亿' },
  { name: '佰维存储', net: '+24.94亿' },
  { name: '兆易创新', net: '+22.88亿' },
  { name: '东方财富', net: '+22.04亿' },
  { name: '香农芯创', net: '+20.84亿' },
];

const keyNews = [
  { title: '沪指站上4200点创11年新高，成交额3.54万亿', priority: 'high' },
  { title: '特朗普将于5月13-15日访华', priority: 'high' },
  { title: 'DeepSeek 500亿天价融资，估值3500亿', priority: 'high' },
  { title: '4月CPI/PPI双双超预期', priority: 'medium' },
  { title: '中芯国际406亿重组过会+存储芯片超级周期', priority: 'high' },
];

const articleContent = `## 市场综述

5月11日，A股市场呈现科技成长逼空行情，半导体板块全面爆发。沪指大涨1.08%站上4200点，创11年新高；深成指涨2.16%，创业板指涨3.50%，科创50暴涨4.65%。两市成交额达3.54万亿，较前日放量明显。

## 核心主线

### 1. 芯片/半导体
半导体板块今日全面爆发，成为市场最强主线。工业气体、半导体材料与设备、半导体产品等子板块涨幅均超5%。消息面上，中芯国际406亿重组过会，叠加存储芯片超级周期预期，板块迎来戴维斯双击。

### 2. AI算力/光通信
AI算力产业链持续强势，寒武纪获主力资金净流入近40亿，领跑个股净流入榜。DeepSeek 500亿天价融资消息刺激板块情绪。

### 3. 机器人
机器人板块延续活跃态势，资金从高位AI硬件向低位机器人切换迹象明显。

### 4. 商业航天
商业航天板块午后异动，多只个股涨停，成为今日新发酵的方向。

## 资金流向

今日主力资金大幅流入科技成长方向，半导体相关个股占据净流入榜前列。DR寒武纪净流入39.83亿居首，佰维存储、兆易创新分别净流入24.94亿和22.88亿。

## 明日前瞻

**重点关注：**
1. 半导体板块持续性，关注龙头个股能否连板
2. 特朗普访华预期对相关板块的刺激
3. 成交量能否维持在3万亿以上
4. 沪指4200点整数关口的支撑力度

> **风险提示：** 以上分析仅供参考，不构成投资建议。股市有风险，投资需谨慎。
`;

function PriorityBadge({ priority }: { priority: string }) {
  if (priority === 'high') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-50 text-[#EF4444]">
        <Zap className="w-3 h-3" />
        重要
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-yellow-50 text-yellow-600">
      关注
    </span>
  );
}

export default function ArticleView() {
  return (
    <section className="w-full py-6 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Section header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="w-1 h-6 bg-[#FF6D00] rounded-full"></div>
          <h2 className="text-xl font-bold text-[#1A237E]">复盘分析</h2>
        </div>

        {/* Article Title Banner */}
        <div className="bg-[#1A237E] rounded-xl p-5 sm:p-7 mb-5 text-white">
          <div className="flex items-start gap-3 mb-3">
            <Newspaper className="w-6 h-6 text-[#FF6D00] flex-shrink-0 mt-0.5" />
            <h3 className="text-lg sm:text-xl font-bold leading-snug">
              2026-05-11 复盘以及05-12日前瞻：半导体全线爆发，沪指11年新高后如何演绎
            </h3>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-white/70 ml-9">
            <span>发布：2026-05-11 15:30</span>
            <span>|</span>
            <span>AI生成</span>
            <span>|</span>
            <span>数据来源：同花顺iFinD</span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Main article */}
          <div className="lg:col-span-2 space-y-5">
            {/* Article content */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 sm:p-7">
              <div className="flex items-center gap-2 mb-4">
                <FileText className="w-5 h-5 text-[#1A237E]" />
                <h4 className="text-base font-bold text-[#333333]">文章正文</h4>
              </div>
              <div className="prose prose-sm max-w-none text-[#333333] leading-relaxed whitespace-pre-line">
                {articleContent}
              </div>
            </div>

            {/* Sector analysis table */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <div className="flex items-center gap-2 mb-4">
                <TrendingUp className="w-5 h-5 text-[#1A237E]" />
                <h4 className="text-base font-bold text-[#333333]">最强板块 TOP5</h4>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[#1A237E]/5">
                      <th className="text-left py-2.5 px-3 font-semibold text-[#333333] rounded-tl-lg">排名</th>
                      <th className="text-left py-2.5 px-3 font-semibold text-[#333333]">板块名称</th>
                      <th className="text-right py-2.5 px-3 font-semibold text-[#333333] rounded-tr-lg">涨跌幅</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topSectors.map((sector, i) => (
                      <tr key={sector.name} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors">
                        <td className="py-2.5 px-3">
                          <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${i === 0 ? 'bg-[#FF6D00] text-white' : i === 1 ? 'bg-[#FF6D00]/80 text-white' : i === 2 ? 'bg-[#FF6D00]/60 text-white' : 'bg-gray-100 text-gray-500'}`}>
                            {i + 1}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 font-medium text-[#333333]">{sector.name}</td>
                        <td className="py-2.5 px-3 text-right">
                          <span className="font-bold text-[#EF4444]">+{sector.pct_chg.toFixed(2)}%</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Stock watch table */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <div className="flex items-center gap-2 mb-4">
                <Target className="w-5 h-5 text-[#1A237E]" />
                <h4 className="text-base font-bold text-[#333333]">主力净流入 TOP5</h4>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[#1A237E]/5">
                      <th className="text-left py-2.5 px-3 font-semibold text-[#333333] rounded-tl-lg">排名</th>
                      <th className="text-left py-2.5 px-3 font-semibold text-[#333333]">个股名称</th>
                      <th className="text-right py-2.5 px-3 font-semibold text-[#333333] rounded-tr-lg">净流入</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topInflow.map((stock, i) => (
                      <tr key={stock.name} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors">
                        <td className="py-2.5 px-3">
                          <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${i === 0 ? 'bg-[#FF6D00] text-white' : i === 1 ? 'bg-[#FF6D00]/80 text-white' : i === 2 ? 'bg-[#FF6D00]/60 text-white' : 'bg-gray-100 text-gray-500'}`}>
                            {i + 1}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 font-medium text-[#333333]">{stock.name}</td>
                        <td className="py-2.5 px-3 text-right">
                          <span className="font-bold text-[#EF4444]">{stock.net}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-5">
            {/* Key news */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <div className="flex items-center gap-2 mb-4">
                <AlertTriangle className="w-5 h-5 text-[#FF6D00]" />
                <h4 className="text-base font-bold text-[#333333]">重点消息</h4>
              </div>
              <div className="space-y-3">
                {keyNews.map((news) => (
                  <div key={news.title} className="flex items-start gap-2.5 group cursor-pointer">
                    <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0 mt-0.5 group-hover:text-[#FF6D00] transition-colors" />
                    <div className="flex-1">
                      <p className="text-sm text-[#333333] leading-snug group-hover:text-[#1A237E] transition-colors">{news.title}</p>
                      <div className="mt-1">
                        <PriorityBadge priority={news.priority} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Core conclusions */}
            <div className="bg-[#1A237E] rounded-xl p-5 text-white">
              <h4 className="text-base font-bold mb-4 flex items-center gap-2">
                <Zap className="w-5 h-5 text-[#FF6D00]" />
                核心结论
              </h4>
              <ol className="space-y-3 text-sm text-white/90">
                <li className="flex gap-2">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#FF6D00] flex items-center justify-center text-xs font-bold">1</span>
                  <span>5月11日市场呈现科技成长逼空行情，半导体板块全面爆发</span>
                </li>
                <li className="flex gap-2">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#FF6D00] flex items-center justify-center text-xs font-bold">2</span>
                  <span>4大核心主线：芯片/半导体、AI算力/光通信、机器人、商业航天</span>
                </li>
                <li className="flex gap-2">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#FF6D00] flex items-center justify-center text-xs font-bold">3</span>
                  <span>资金正在从高位AI硬件向低位芯片/机器人切换</span>
                </li>
                <li className="flex gap-2">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#FF6D00] flex items-center justify-center text-xs font-bold">4</span>
                  <span>明日重点关注：半导体持续性、特朗普访华预期、成交量能否维持3万亿</span>
                </li>
              </ol>
            </div>

            {/* Data source */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <h4 className="text-sm font-bold text-[#333333] mb-3">数据来源</h4>
              <div className="space-y-2 text-xs text-gray-500">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#1A237E]"></span>
                  <span>同花顺 iFinD</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#1A237E]"></span>
                  <span>东方财富 Choice</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#1A237E]"></span>
                  <span>上交所 / 深交所</span>
                </div>
                <p className="text-gray-400 mt-3 pt-2 border-t border-gray-100">
                  数据更新时间：2026-05-11 15:05
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
