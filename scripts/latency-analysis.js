#!/usr/bin/env node

/**
 * Latency Analysis Script for Voice Pipeline
 * 
 * This script analyzes the current voice pipeline performance by:
 * 1. Running performance monitoring
 * 2. Generating detailed latency reports
 * 3. Identifying optimization opportunities
 */

const performanceMonitor = require('../src/utils/performanceMonitor');
const logger = require('../src/utils/logger');

async function runLatencyAnalysis() {
  console.log('🔍 Starting Voice Pipeline Latency Analysis...\n');
  
  try {
    // Generate current performance report
    const report = performanceMonitor.getDetailedLatencyReport();
    
    console.log('📊 CURRENT PERFORMANCE METRICS');
    console.log('================================');
    
    if (report.stages && Object.keys(report.stages).length > 0) {
      console.log('\n⏱️  Stage Latencies:');
      for (const [stage, metrics] of Object.entries(report.stages)) {
        console.log(`  ${stage.padEnd(20)}: ${Math.round(metrics.avg)}ms avg (${metrics.min}-${metrics.max}ms range, p95: ${Math.round(metrics.p95)}ms)`);
      }
    } else {
      console.log('\n⚠️  No performance data available yet.');
      console.log('   Run some voice calls first to collect metrics.');
    }
    
    if (report.connectionSetup && Object.keys(report.connectionSetup).length > 0) {
      console.log('\n🔗 Connection Setup Times:');
      for (const [stage, metrics] of Object.entries(report.connectionSetup)) {
        console.log(`  ${stage.padEnd(20)}: ${Math.round(metrics.avg)}ms avg`);
      }
    }
    
    if (report.analysis && Object.keys(report.analysis).length > 0) {
      console.log('\n📈 PERFORMANCE ANALYSIS');
      console.log('========================');
      
      for (const [metric, analysis] of Object.entries(report.analysis)) {
        const status = analysis.status === 'GOOD' ? '✅' : 
                      analysis.status === 'ACCEPTABLE' ? '⚠️' : '❌';
        console.log(`${status} ${metric}: ${Math.round(analysis.average)}ms (Target: ${analysis.target}) - ${analysis.status}`);
      }
    }
    
    console.log('\n🎯 OPTIMIZATION OPPORTUNITIES');
    console.log('==============================');
    
    // Analyze potential bottlenecks
    const opportunities = [];
    
    if (report.stages) {
      // Check each stage for optimization potential
      if (report.stages.llm && report.stages.llm.avg > 800) {
        opportunities.push({
          area: 'LLM Processing',
          current: `${Math.round(report.stages.llm.avg)}ms`,
          target: '<800ms',
          strategies: [
            'Use smaller/faster model (gpt-4.1-nano → gpt-3.5-turbo or keep current)',
            'Implement response caching for common patterns',
            'Optimize prompt length and structure',
            'Use streaming responses to reduce perceived latency'
          ]
        });
      }
      
      if (report.stages.tts && report.stages.tts.avg > 500) {
        opportunities.push({
          area: 'Text-to-Speech',
          current: `${Math.round(report.stages.tts.avg)}ms`,
          target: '<500ms',
          strategies: [
            'Use ElevenLabs Turbo v2.5 (faster model)',
            'Implement aggressive TTS caching',
            'Use streaming TTS for real-time generation',
            'Pre-generate common responses'
          ]
        });
      }
      
      if (report.stages.transcode && report.stages.transcode.avg > 200) {
        opportunities.push({
          area: 'Audio Transcoding',
          current: `${Math.round(report.stages.transcode.avg)}ms`,
          target: '<200ms',
          strategies: [
            'Use FFmpeg process pooling',
            'Optimize FFmpeg parameters for speed',
            'Consider hardware acceleration',
            'Use direct μ-law output from TTS if possible'
          ]
        });
      }
      
      if (report.stages['first-audio-chunk'] && report.stages['first-audio-chunk'].avg > 1500) {
        opportunities.push({
          area: 'End-to-End Latency',
          current: `${Math.round(report.stages['first-audio-chunk'].avg)}ms`,
          target: '<1500ms',
          strategies: [
            'Implement speculative TTS (start synthesis before LLM completes)',
            'Use parallel processing for TTS and transcoding',
            'Optimize WebSocket connection management',
            'Reduce buffering delays'
          ]
        });
      }
    }
    
    // Cache performance analysis
    if (report.analysis.cachePerformance && report.analysis.cachePerformance.hitRate < 70) {
      opportunities.push({
        area: 'Cache Performance',
        current: `${report.analysis.cachePerformance.hitRate}%`,
        target: '>70%',
        strategies: [
          'Improve cache key generation for better matching',
          'Implement phonetic similarity matching',
          'Increase cache TTL for stable responses',
          'Pre-populate cache with common conversation patterns'
        ]
      });
    }
    
    // Generic optimization opportunities
    opportunities.push({
      area: 'Infrastructure',
      current: 'Various',
      target: 'Optimized',
      strategies: [
        'Use Redis for ultra-fast caching',
        'Implement connection pooling for all WebSocket services',
        'Use CDN for static audio assets',
        'Optimize database queries with proper indexing',
        'Implement request batching where possible'
      ]
    });
    
    if (opportunities.length === 0) {
      console.log('✅ All metrics are within optimal ranges!');
    } else {
      opportunities.forEach((opp, index) => {
        console.log(`\n${index + 1}. ${opp.area} (${opp.current} → ${opp.target})`);
        opp.strategies.forEach(strategy => {
          console.log(`   • ${strategy}`);
        });
      });
    }
    
    console.log('\n📋 RECOMMENDED IMPLEMENTATION ORDER');
    console.log('====================================');
    console.log('1. Enable speculative TTS streaming (biggest impact)');
    console.log('2. Implement FFmpeg process pooling');
    console.log('3. Optimize LLM model selection and caching');
    console.log('4. Enhance TTS caching with phonetic matching');
    console.log('5. Fine-tune connection pooling parameters');
    console.log('6. Implement hardware acceleration where available');
    
    console.log('\n🧪 TESTING RECOMMENDATIONS');
    console.log('===========================');
    console.log('• Run multiple voice calls to collect more data');
    console.log('• Test with different user input patterns');
    console.log('• Monitor performance under concurrent call load');
    console.log('• Compare performance with/without optimizations');
    
    console.log('\n✅ Analysis complete! Use voice-test.js to generate more performance data.\n');
    
  } catch (error) {
    console.error('❌ Error during latency analysis:', error.message);
    process.exit(1);
  }
}

// Run analysis if called directly
if (require.main === module) {
  runLatencyAnalysis().catch(console.error);
}

module.exports = { runLatencyAnalysis };