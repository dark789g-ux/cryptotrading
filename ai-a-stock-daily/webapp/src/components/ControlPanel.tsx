import { useState } from 'react';
import { Play, Clock, Settings, LogOut, CheckCircle, AlertTriangle, ChevronDown, ToggleLeft, ToggleRight, FileText, Video, Music, AlertCircle } from 'lucide-react';

const runLogs = [
  { date: '2026-05-11 15:05', status: 'success', duration: '4分32秒', outputs: ['文章', '微信视频', '抖音视频', '音频'] },
  { date: '2026-05-10 15:05', status: 'success', duration: '3分58秒', outputs: ['文章', '微信视频', '音频'] },
  { date: '2026-05-09 15:05', status: 'success', duration: '4分15秒', outputs: ['文章', '音频'] },
  { date: '2026-05-08 15:05', status: 'success', duration: '3分45秒', outputs: ['文章', '微信视频', '抖音视频', '音频'] },
  { date: '2026-05-07 15:05', status: 'partial', duration: '5分02秒', outputs: ['文章'] },
];

type OutputFormat = 'article' | 'wechat' | 'douyin' | 'audio';

export default function ControlPanel() {
  const [autoRun, setAutoRun] = useState(true);
  const [runTime, setRunTime] = useState('15:05');
  const [outputFormats, setOutputFormats] = useState<OutputFormat[]>(['article', 'wechat', 'douyin', 'audio']);
  const [isRunning, setIsRunning] = useState(false);

  const toggleFormat = (format: OutputFormat) => {
    setOutputFormats(prev =>
      prev.includes(format)
        ? prev.filter(f => f !== format)
        : [...prev, format]
    );
  };

  const handleRun = () => {
    setIsRunning(true);
    setTimeout(() => setIsRunning(false), 3000);
  };

  const formatLabels: Record<OutputFormat, string> = {
    article: '文章',
    wechat: '微信视频',
    douyin: '抖音视频',
    audio: '音频',
  };

  const formatIcons: Record<OutputFormat, React.ReactNode> = {
    article: <FileText className="w-3.5 h-3.5" />,
    wechat: <Video className="w-3.5 h-3.5" />,
    douyin: <Video className="w-3.5 h-3.5" />,
    audio: <Music className="w-3.5 h-3.5" />,
  };

  return (
    <section className="w-full py-6 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Section header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="w-1 h-6 bg-[#FF6D00] rounded-full"></div>
          <h2 className="text-xl font-bold text-[#1A237E]">控制面板</h2>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Left: Run button + Auto config */}
          <div className="lg:col-span-2 space-y-5">
            {/* Run button card */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <button
                onClick={handleRun}
                disabled={isRunning}
                className={`w-full py-5 rounded-xl text-white font-bold text-lg flex items-center justify-center gap-3 transition-all ${
                  isRunning
                    ? 'bg-gray-400 cursor-not-allowed'
                    : 'bg-[#FF6D00] hover:bg-[#FF6D00]/90 hover:shadow-lg active:scale-[0.99]'
                }`}
              >
                {isRunning ? (
                  <>
                    <span className="w-6 h-6 border-3 border-white/30 border-t-white rounded-full animate-spin"></span>
                    复盘运行中...
                  </>
                ) : (
                  <>
                    <Play className="w-6 h-6" />
                    立即运行复盘
                  </>
                )}
              </button>
              <p className="text-center text-sm text-gray-500 mt-3">
                点击后将自动抓取当日行情数据，生成复盘文章、视频及音频
              </p>
            </div>

            {/* Auto run settings */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
              <div className="flex items-center gap-2 mb-4">
                <Settings className="w-5 h-5 text-[#1A237E]" />
                <h3 className="text-base font-bold text-[#333333]">自动运行配置</h3>
              </div>

              <div className="space-y-4">
                {/* Auto run toggle */}
                <div className="flex items-center justify-between py-2">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${autoRun ? 'bg-green-50' : 'bg-gray-100'}`}>
                      <Clock className={`w-5 h-5 ${autoRun ? 'text-green-600' : 'text-gray-400'}`} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-[#333333]">自动运行</p>
                      <p className="text-xs text-gray-500">收盘后自动执行复盘</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setAutoRun(!autoRun)}
                    className="transition-colors"
                  >
                    {autoRun ? (
                      <ToggleRight className="w-10 h-10 text-green-500" />
                    ) : (
                      <ToggleLeft className="w-10 h-10 text-gray-300" />
                    )}
                  </button>
                </div>

                {/* Time picker */}
                <div className="flex items-center justify-between py-2">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-[#1A237E]/10 flex items-center justify-center">
                      <Clock className="w-5 h-5 text-[#1A237E]" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-[#333333]">运行时间</p>
                      <p className="text-xs text-gray-500">收盘后自动运行</p>
                    </div>
                  </div>
                  <div className="relative">
                    <input
                      type="time"
                      value={runTime}
                      onChange={(e) => setRunTime(e.target.value)}
                      className="pl-3 pr-8 py-2 border border-gray-200 rounded-lg text-sm font-medium text-[#333333] focus:outline-none focus:ring-2 focus:ring-[#1A237E]/20 focus:border-[#1A237E]"
                    />
                    <ChevronDown className="w-4 h-4 text-gray-400 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                  </div>
                </div>

                {/* Output format */}
                <div className="py-2">
                  <p className="text-sm font-medium text-[#333333] mb-3">输出格式</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {(Object.keys(formatLabels) as OutputFormat[]).map((format) => (
                      <button
                        key={format}
                        onClick={() => toggleFormat(format)}
                        className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-all border ${
                          outputFormats.includes(format)
                            ? 'bg-[#1A237E] text-white border-[#1A237E]'
                            : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        {formatIcons[format]}
                        {formatLabels[format]}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right: Run logs */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <div className="flex items-center gap-2 mb-4">
              <LogOut className="w-5 h-5 text-[#1A237E]" />
              <h3 className="text-base font-bold text-[#333333]">运行日志</h3>
              <span className="ml-auto text-xs text-gray-400">最近5次</span>
            </div>

            <div className="space-y-3">
              {runLogs.map((log, index) => (
                <div
                  key={log.date}
                  className={`p-3 rounded-lg border ${
                    index === 0 ? 'border-[#1A237E]/20 bg-[#1A237E]/5' : 'border-gray-100 bg-gray-50/50'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium text-gray-500">{log.date}</span>
                    {log.status === 'success' ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600">
                        <CheckCircle className="w-3.5 h-3.5" />
                        成功
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-yellow-600">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        部分完成
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400">耗时 {log.duration}</span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {log.outputs.map((output) => (
                      <span
                        key={output}
                        className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-white border border-gray-200 text-gray-600"
                      >
                        {output}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Disclaimer */}
        <div className="mt-5 bg-gray-50 border border-gray-200 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-gray-400 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="text-sm font-bold text-gray-600 mb-1">系统说明</h4>
              <p className="text-xs text-gray-500 leading-relaxed">
                本系统每日收盘后自动运行，基于当日A股市场公开数据生成复盘报告。
                自动运行时间默认为15:05（收盘后5分钟），以确保获取完整行情数据。
                生成内容包括Markdown格式文章、微信视频号横版视频、抖音竖版视频以及AI配音音频。
                所有内容仅供学习参考，不构成任何投资建议。
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
