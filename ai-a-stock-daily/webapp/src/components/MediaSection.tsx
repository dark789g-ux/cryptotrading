import { Video, Music, Download, Smartphone, Monitor, AlertCircle } from 'lucide-react';

export default function MediaSection() {
  return (
    <section className="w-full py-6 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Section header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="w-1 h-6 bg-[#FF6D00] rounded-full"></div>
          <h2 className="text-xl font-bold text-[#1A237E]">媒体资源</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-5">
          {/* WeChat Video Card */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="bg-[#1A237E] px-5 py-3 flex items-center gap-2">
              <Monitor className="w-5 h-5 text-[#FF6D00]" />
              <h3 className="text-base font-bold text-white">微信视频号版本</h3>
              <span className="ml-auto text-xs text-white/60 bg-white/10 px-2 py-0.5 rounded">16:9</span>
            </div>
            <div className="p-5">
              <div className="relative w-full pb-[56.25%] bg-gray-100 rounded-lg overflow-hidden mb-4">
                <video
                  className="absolute inset-0 w-full h-full object-cover"
                  controls
                  preload="metadata"
                  poster=""
                >
                  <source src="/video_wechat_preview.mp4" type="video/mp4" />
                  您的浏览器不支持视频播放。
                </video>
              </div>
              <div className="flex items-center justify-between">
                <div className="text-sm text-gray-500">
                  <p className="font-medium text-[#333333]">微信视频号预览</p>
                  <p className="text-xs mt-0.5">横版 16:9 · 适合朋友圈/视频号</p>
                </div>
                <a
                  href="/video_wechat_preview.mp4"
                  download
                  className="inline-flex items-center gap-2 px-4 py-2 bg-[#FF6D00] text-white rounded-lg text-sm font-medium hover:bg-[#FF6D00]/90 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  下载
                </a>
              </div>
            </div>
          </div>

          {/* Douyin Video Card */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="bg-[#1A237E] px-5 py-3 flex items-center gap-2">
              <Smartphone className="w-5 h-5 text-[#FF6D00]" />
              <h3 className="text-base font-bold text-white">抖音版本</h3>
              <span className="ml-auto text-xs text-white/60 bg-white/10 px-2 py-0.5 rounded">9:16</span>
            </div>
            <div className="p-5">
              <div className="relative w-full pb-[177.78%] bg-gray-100 rounded-lg overflow-hidden mb-4 max-h-64">
                <video
                  className="absolute inset-0 w-full h-full object-cover"
                  controls
                  preload="metadata"
                  poster=""
                >
                  <source src="/video_douyin_preview.mp4" type="video/mp4" />
                  您的浏览器不支持视频播放。
                </video>
              </div>
              <div className="flex items-center justify-between">
                <div className="text-sm text-gray-500">
                  <p className="font-medium text-[#333333]">抖音竖版预览</p>
                  <p className="text-xs mt-0.5">竖版 9:16 · 适合抖音/快手</p>
                </div>
                <a
                  href="/video_douyin_preview.mp4"
                  download
                  className="inline-flex items-center gap-2 px-4 py-2 bg-[#FF6D00] text-white rounded-lg text-sm font-medium hover:bg-[#FF6D00]/90 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  下载
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Audio Download */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 mb-5">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex items-center gap-3 flex-1">
              <div className="w-12 h-12 rounded-xl bg-[#1A237E]/10 flex items-center justify-center flex-shrink-0">
                <Music className="w-6 h-6 text-[#1A237E]" />
              </div>
              <div>
                <h4 className="text-base font-bold text-[#333333]">配音音频</h4>
                <p className="text-sm text-gray-500">AI语音合成 · 完整版复盘音频</p>
              </div>
            </div>
            <audio controls className="w-full sm:w-64" preload="none">
              <source src="/audio_wechat_full.mp3" type="audio/mpeg" />
              您的浏览器不支持音频播放。
            </audio>
            <a
              href="/audio_wechat_full.mp3"
              download
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-[#1A237E] text-white rounded-lg text-sm font-medium hover:bg-[#1A237E]/90 transition-colors flex-shrink-0"
            >
              <Download className="w-4 h-4" />
              下载音频
            </a>
          </div>
        </div>

        {/* Disclaimer */}
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="text-sm font-bold text-yellow-800 mb-1">免责声明</h4>
              <p className="text-xs text-yellow-700 leading-relaxed">
                本系统生成的所有内容（包括文章、视频、音频）均由AI基于公开数据自动生成，仅供参考，不构成任何投资建议。
                股市有风险，投资需谨慎。投资者应独立做出投资决策，自行承担投资风险。过往业绩不代表未来表现，
                市场数据可能存在延迟，请以交易所官方数据为准。
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
