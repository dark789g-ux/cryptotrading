import Navbar from './components/Navbar';
import Dashboard from './components/Dashboard';
import ArticleView from './components/ArticleView';
import MediaSection from './components/MediaSection';
import ControlPanel from './components/ControlPanel';

function Footer() {
  return (
    <footer className="w-full bg-[#1A237E] text-white py-8 px-4 sm:px-6 lg:px-8 mt-auto">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#FF6D00] flex items-center justify-center">
              <span className="text-sm font-bold">AI</span>
            </div>
            <div>
              <p className="text-sm font-medium">AI每日复盘系统</p>
              <p className="text-xs text-white/60">A股市场 · 智能分析</p>
            </div>
          </div>
          <div className="text-center sm:text-right">
            <p className="text-xs text-white/50">
              数据来源：同花顺iFinD · 东方财富Choice · 上交所/深交所
            </p>
            <p className="text-xs text-white/40 mt-1">
              本系统生成的所有内容仅供参考，不构成投资建议。股市有风险，投资需谨慎。
            </p>
          </div>
        </div>
        <div className="border-t border-white/10 mt-4 pt-4 text-center">
          <p className="text-xs text-white/30">
            &copy; 2026 AI每日复盘系统 · 仅供学习研究使用
          </p>
        </div>
      </div>
    </footer>
  );
}

function App() {
  return (
    <div className="min-h-screen flex flex-col bg-[#F5F5F5]">
      <Navbar />
      <main className="flex-1 w-full">
        <Dashboard />
        <div className="w-full h-px bg-gradient-to-r from-transparent via-gray-200 to-transparent" />
        <ArticleView />
        <div className="w-full h-px bg-gradient-to-r from-transparent via-gray-200 to-transparent" />
        <MediaSection />
        <div className="w-full h-px bg-gradient-to-r from-transparent via-gray-200 to-transparent" />
        <ControlPanel />
      </main>
      <Footer />
    </div>
  );
}

export default App;
