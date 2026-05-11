import { TrendingUp, TrendingDown, BarChart3, CircleDollarSign, ArrowUpRight, ArrowDownRight } from 'lucide-react';

interface IndexData {
  name: string;
  code: string;
  close: number;
  change: number;
  pct_chg: number;
  amount: string;
}

const indices: IndexData[] = [
  { name: '上证指数', code: '000001.SH', close: 4225.02, change: 45.07, pct_chg: 1.08, amount: '1.58万亿' },
  { name: '深证成指', code: '399001.SZ', close: 15899.30, change: 335.50, pct_chg: 2.16, amount: '1.95万亿' },
  { name: '创业板指', code: '399006.SZ', close: 3928.97, change: 132.85, pct_chg: 3.50, amount: '0.92万亿' },
  { name: '科创50', code: '000688.SH', close: 1716.69, change: 76.23, pct_chg: 4.65, amount: '0.18万亿' },
];

const marketSummary = {
  up_count: 3121,
  down_count: 2239,
  flat_count: 131,
  up_limit: 201,
  down_limit: 28,
  total_amount: '3.54万亿',
};

function IndexCard({ data }: { data: IndexData }) {
  const isUp = data.pct_chg >= 0;
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 flex flex-col hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-base font-bold text-[#333333]">{data.name}</h3>
          <span className="text-xs text-gray-400">{data.code}</span>
        </div>
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${isUp ? 'bg-red-50' : 'bg-green-50'}`}>
          {isUp ? <TrendingUp className="w-5 h-5 text-[#EF4444]" /> : <TrendingDown className="w-5 h-5 text-[#22C55E]" />}
        </div>
      </div>
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-2xl sm:text-3xl font-bold text-[#333333]">{data.close.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className={`inline-flex items-center gap-0.5 text-sm font-semibold ${isUp ? 'text-[#EF4444]' : 'text-[#22C55E]'}`}>
          {isUp ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownRight className="w-4 h-4" />}
          {isUp ? '+' : ''}{data.change.toFixed(2)}
        </span>
        <span className={`text-sm font-semibold px-2 py-0.5 rounded ${isUp ? 'bg-red-50 text-[#EF4444]' : 'bg-green-50 text-[#22C55E]'}`}>
          {isUp ? '+' : ''}{data.pct_chg.toFixed(2)}%
        </span>
      </div>
      <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-1.5">
        <CircleDollarSign className="w-3.5 h-3.5 text-gray-400" />
        <span className="text-xs text-gray-500">成交额 {data.amount}</span>
      </div>
    </div>
  );
}

function PieChart() {
  const total = marketSummary.up_count + marketSummary.down_count + marketSummary.flat_count;
  const upDeg = (marketSummary.up_count / total) * 360;
  const downDeg = (marketSummary.down_count / total) * 360;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
      <h3 className="text-base font-bold text-[#333333] mb-4 flex items-center gap-2">
        <BarChart3 className="w-5 h-5 text-[#1A237E]" />
        涨跌分布
      </h3>
      <div className="flex items-center gap-5">
        {/* Pie */}
        <div className="relative w-28 h-28 flex-shrink-0">
          <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
            <circle cx="50" cy="50" r="40" fill="none" stroke="#EF4444" strokeWidth="20"
              strokeDasharray={`${(upDeg / 360) * 251.2} 251.2`} />
            <circle cx="50" cy="50" r="40" fill="none" stroke="#22C55E" strokeWidth="20"
              strokeDasharray={`${(downDeg / 360) * 251.2} 251.2`}
              strokeDashoffset={`-${(upDeg / 360) * 251.2}`} />
            <circle cx="50" cy="50" r="40" fill="none" stroke="#9CA3AF" strokeWidth="20"
              strokeDasharray={`${((360 - upDeg - downDeg) / 360) * 251.2} 251.2`}
              strokeDashoffset={`-${((upDeg + downDeg) / 360) * 251.2}`} />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-lg font-bold text-[#333333]">{total}</span>
          </div>
        </div>
        {/* Legend */}
        <div className="flex flex-col gap-2.5 flex-1">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-[#EF4444]"></span>
              <span className="text-sm text-[#333333]">上涨</span>
            </div>
            <span className="text-sm font-bold text-[#EF4444]">{marketSummary.up_count}家</span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-[#22C55E]"></span>
              <span className="text-sm text-[#333333]">下跌</span>
            </div>
            <span className="text-sm font-bold text-[#22C55E]">{marketSummary.down_count}家</span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-gray-400"></span>
              <span className="text-sm text-[#333333]">平盘</span>
            </div>
            <span className="text-sm font-bold text-gray-500">{marketSummary.flat_count}家</span>
          </div>
          <div className="border-t border-gray-100 pt-2 flex items-center justify-between">
            <span className="text-xs text-gray-500">涨停</span>
            <span className="text-xs font-bold text-[#EF4444]">{marketSummary.up_limit}家</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">跌停</span>
            <span className="text-xs font-bold text-[#22C55E]">{marketSummary.down_limit}家</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function AmountCard() {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
      <h3 className="text-base font-bold text-[#333333] mb-3 flex items-center gap-2">
        <CircleDollarSign className="w-5 h-5 text-[#FF6D00]" />
        两市成交额
      </h3>
      <div className="flex flex-col">
        <span className="text-3xl sm:text-4xl font-bold text-[#FF6D00]">{marketSummary.total_amount}</span>
        <span className="text-sm text-gray-500 mt-1">较前日 +12.3%</span>
      </div>
      <div className="mt-4 space-y-2">
        {indices.map((idx) => (
          <div key={idx.code} className="flex items-center justify-between text-sm">
            <span className="text-gray-500">{idx.name}</span>
            <span className="font-medium text-[#333333]">{idx.amount}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  return (
    <section className="w-full py-6 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Section header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="w-1 h-6 bg-[#FF6D00] rounded-full"></div>
          <h2 className="text-xl font-bold text-[#1A237E]">大盘概览</h2>
          <span className="text-sm text-gray-500 ml-2">2026-05-11 收盘数据</span>
        </div>

        {/* Index cards grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          {indices.map((data) => (
            <IndexCard key={data.code} data={data} />
          ))}
        </div>

        {/* Bottom row: Pie + Amount */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <PieChart />
          <AmountCard />
        </div>
      </div>
    </section>
  );
}
