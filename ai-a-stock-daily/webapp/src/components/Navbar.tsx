import { Activity } from 'lucide-react';

export default function Navbar() {
  const today = new Date('2026-05-11');
  const dateStr = `${today.getFullYear()}年${String(today.getMonth() + 1).padStart(2, '0')}月${String(today.getDate()).padStart(2, '0')}日`;
  const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekStr = weekDays[today.getDay()];

  return (
    <nav className="w-full bg-[#1A237E] text-white shadow-lg sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Left: Brand */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-[#FF6D00] flex items-center justify-center">
              <Activity className="w-5 h-5 text-white" />
            </div>
            <div className="flex flex-col">
              <span className="text-lg font-bold leading-tight tracking-wide">AI每日复盘</span>
              <span className="text-xs text-white/70 leading-tight hidden sm:block">A股市场 · 智能分析系统</span>
            </div>
          </div>

          {/* Right: Date + Status */}
          <div className="flex items-center gap-4">
            <div className="hidden sm:flex flex-col items-end">
              <span className="text-sm font-medium">{dateStr}</span>
              <span className="text-xs text-white/60">{weekStr}</span>
            </div>
            <div className="flex items-center gap-2 bg-white/10 rounded-full px-3 py-1.5">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"></span>
              </span>
              <span className="text-xs font-medium text-green-300">系统运行中</span>
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}
