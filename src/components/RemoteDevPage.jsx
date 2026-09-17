import { useState, useEffect, useRef } from 'react';
import { FolderOpen, FileCode, Save, Play, Download, Upload, X, ChevronRight, ChevronDown, RefreshCw, CheckCircle, AlertCircle, Clock } from 'lucide-react';

const API_BASE = '/api/remote-dev';

export default function RemoteDevPage({ session }) {
  const [connected, setConnected] = useState(false);
  const [files, setFiles] = useState([]);
  const [currentFile, setCurrentFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [compilationStatus, setCompilationStatus] = useState(null);
  const [deploymentStatus, setDeploymentStatus] = useState(null);
  const [expandedFolders, setExpandedFolders] = useState(new Set(['src']));
  const fileInputRef = useRef(null);

  // Connect to remote dev workspace on mount
  useEffect(() => {
    connectToWorkspace();
  }, []);

  async function connectToWorkspace() {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/connect`, {
        headers: { Authorization: `Bearer ${session.token}` }
      });
      
      if (!res.ok) {
        throw new Error('Failed to connect to remote workspace');
      }
      
      const data = await res.json();
      setConnected(true);
      loadFileTree(data.workspacePath);
    } catch (err) {
      setError(err.message);
      setConnected(false);
    } finally {
      setIsLoading(false);
    }
  }

  async function loadFileTree(workspacePath) {
    try {
      const res = await fetch(`${API_BASE}/files?path=${encodeURIComponent(workspacePath || '~')}`, {
        headers: { Authorization: `Bearer ${session.token}` }
      });
      
      if (!res.ok) throw new Error('Failed to load files');
      
      const data = await res.json();
      setFiles(data.files || []);
    } catch (err) {
      setError(err.message);
    }
  }

  async function loadFile(filePath) {
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/file?path=${encodeURIComponent(filePath)}`, {
        headers: { Authorization: `Bearer ${session.token}` }
      });
      
      if (!res.ok) throw new Error('Failed to load file');
      
      const data = await res.json();
      setCurrentFile(filePath);
      setFileContent(data.content || '');
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function saveFile() {
    if (!currentFile) return;
    
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/file`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`
        },
        body: JSON.stringify({
          path: currentFile,
          content: fileContent
        })
      });
      
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to save file');
      }
      
      // Show success feedback
      const originalContent = fileContent;
      setTimeout(() => {
        if (fileContent === originalContent) {
          // Still saved successfully
        }
      }, 1000);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function compileAndDeploy(target = 'simulation') {
    setCompilationStatus({ status: 'compiling', message: 'Compiling code...' });
    
    try {
      // Submit compilation job
      const compileRes = await fetch('/api/robot/compile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`
        },
        body: JSON.stringify({
          workspacePath: '~/Jarvis/dev/workspaces',
          target,
          javaVersion: '17'
        })
      });
      
      const compileData = await compileRes.json();
      
      if (!compileData.success) {
        throw new Error(compileData.error || 'Compilation failed');
      }
      
      setCompilationStatus({ status: 'compiling', message: 'Compilation in progress...', jobId: compileData.jobId });
      
      // Poll for completion
      let completed = false;
      while (!completed) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const statusRes = await fetch(`/api/robot/compile/${compileData.jobId}/status`, {
          headers: { Authorization: `Bearer ${session.token}` }
        });
        
        const statusData = await statusRes.json();
        
        if (statusData.status === 'completed') {
          completed = true;
          setCompilationStatus({ status: 'success', message: 'Compilation successful!' });
          
          // Deploy if target is robot
          if (target === 'robot') {
            await deployCode(statusData.artifactPath);
          }
        } else if (statusData.status === 'failed') {
          completed = true;
          setCompilationStatus({ status: 'error', message: statusData.error || 'Compilation failed' });
        }
      }
    } catch (err) {
      setCompilationStatus({ status: 'error', message: err.message });
    }
  }

  async function deployCode(artifactPath) {
    setDeploymentStatus({ status: 'deploying', message: 'Deploying to robot...' });
    
    try {
      const res = await fetch('/api/robot/deploy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`
        },
        body: JSON.stringify({
          artifactPath
        })
      });
      
      const data = await res.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Deployment failed');
      }
      
      setDeploymentStatus({ status: 'success', message: 'Successfully deployed to robot!' });
    } catch (err) {
      setDeploymentStatus({ status: 'error', message: err.message });
    }
  }

  function toggleFolder(folderPath) {
    const newExpanded = new Set(expandedFolders);
    if (newExpanded.has(folderPath)) {
      newExpanded.delete(folderPath);
    } else {
      newExpanded.add(folderPath);
    }
    setExpandedFolders(newExpanded);
  }

  function renderFileTree(items, depth = 0) {
    if (!items || items.length === 0) {
      return <div style={{ paddingLeft: depth * 16, color: '#6b7280', fontSize: '13px' }}>Empty folder</div>;
    }
    
    return items.map(item => {
      const isFolder = item.type === 'folder';
      const isExpanded = expandedFolders.has(item.path);
      const isActive = currentFile === item.path;
      
      return (
        <div key={item.path}>
          <div
            onClick={() => isFolder ? toggleFolder(item.path) : loadFile(item.path)}
            style={{
              paddingLeft: depth * 16 + 8,
              paddingRight: 8,
              paddingVertical: 6,
              cursor: 'pointer',
              background: isActive ? 'rgba(20, 83, 45, 0.3)' : 'transparent',
              color: isActive ? '#ffffff' : '#d1d5db',
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: '13px'
            }}
            onMouseEnter={e => {
              if (!isActive) e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
            }}
            onMouseLeave={e => {
              if (!isActive) e.currentTarget.style.background = 'transparent';
            }}
          >
            {isFolder ? (
              <>
                {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                <FolderOpen className="w-3.5 h-3.5 text-yellow-400" />
              </>
            ) : (
              <>
                <span style={{ width: 14 }} />
                <FileCode className="w-3.5 h-3.5 text-blue-400" />
              </>
            )}
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.name}
            </span>
          </div>
          {isFolder && isExpanded && item.children && (
            <div>{renderFileTree(item.children, depth + 1)}</div>
          )}
        </div>
      );
    });
  }

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col" style={{ background: '#1f2937' }}>
      {/* Header */}
      <div style={{ 
        borderBottom: '1px solid #374151', 
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: '#111827'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ color: '#ffffff', fontSize: '16px', fontWeight: 600 }}>
            Remote Development Workspace
          </h2>
          <span style={{
            fontSize: '12px',
            padding: '2px 8px',
            borderRadius: 12,
            background: connected ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
            color: connected ? '#22c55e' : '#ef4444',
            border: `1px solid ${connected ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`
          }}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={connectToWorkspace}
            disabled={isLoading}
            style={{
              padding: '6px 12px',
              background: 'rgba(20, 83, 45, 0.8)',
              color: '#ffffff',
              border: '1px solid rgba(34, 197, 94, 0.4)',
              borderRadius: 6,
              fontSize: '13px',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              opacity: isLoading ? 0.6 : 1,
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          
          <button
            onClick={() => compileAndDeploy('simulation')}
            disabled={!connected || isLoading}
            style={{
              padding: '6px 12px',
              background: compilationStatus?.status === 'compiling' ? 'rgba(234, 179, 8, 0.8)' : 'rgba(59, 130, 246, 0.8)',
              color: '#ffffff',
              border: '1px solid rgba(59, 130, 246, 0.4)',
              borderRadius: 6,
              fontSize: '13px',
              cursor: !connected || isLoading ? 'not-allowed' : 'pointer',
              opacity: !connected || isLoading ? 0.6 : 1,
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <Play className="w-3.5 h-3.5" />
            Compile (Sim)
          </button>
          
          <button
            onClick={() => compileAndDeploy('robot')}
            disabled={!connected || isLoading}
            style={{
              padding: '6px 12px',
              background: deploymentStatus?.status === 'deploying' ? 'rgba(234, 179, 8, 0.8)' : 'rgba(20, 83, 45, 0.8)',
              color: '#ffffff',
              border: '1px solid rgba(34, 197, 94, 0.4)',
              borderRadius: 6,
              fontSize: '13px',
              cursor: !connected || isLoading ? 'not-allowed' : 'pointer',
              opacity: !connected || isLoading ? 0.6 : 1,
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <Upload className="w-3.5 h-3.5" />
            Deploy to Robot
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* File Tree Sidebar */}
        <div style={{
          width: 280,
          borderRight: '1px solid #374151',
          background: '#111827',
          overflowY: 'auto',
          padding: 8
        }}>
          <div style={{
            color: '#9ca3af',
            fontSize: '11px',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            marginBottom: 8,
            padding: '4px 8px'
          }}>
            ~/Jarvis/dev/workspaces
          </div>
          {renderFileTree(files)}
        </div>

        {/* Editor Area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#1f2937' }}>
          {currentFile ? (
            <>
              {/* File Tab */}
              <div style={{
                borderBottom: '1px solid #374151',
                padding: '8px 16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: '#111827'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <FileCode className="w-4 h-4 text-blue-400" />
                  <span style={{ color: '#ffffff', fontSize: '14px' }}>{currentFile}</span>
                </div>
                
                <button
                  onClick={saveFile}
                  disabled={isLoading}
                  style={{
                    padding: '4px 12px',
                    background: 'rgba(34, 197, 94, 0.8)',
                    color: '#ffffff',
                    border: '1px solid rgba(34, 197, 94, 0.4)',
                    borderRadius: 4,
                    fontSize: '12px',
                    cursor: isLoading ? 'not-allowed' : 'pointer',
                    opacity: isLoading ? 0.6 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4
                  }}
                >
                  <Save className="w-3.5 h-3.5" />
                  Save
                </button>
              </div>
              
              {/* Code Editor */}
              <textarea
                value={fileContent}
                onChange={e => setFileContent(e.target.value)}
                style={{
                  flex: 1,
                  width: '100%',
                  padding: 16,
                  background: '#1f2937',
                  color: '#e5e7eb',
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                  fontFamily: 'JetBrains Mono, Fira Code, monospace',
                  fontSize: '14px',
                  lineHeight: 1.6
                }}
                spellCheck={false}
              />
            </>
          ) : (
            <div style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#6b7280',
              flexDirection: 'column',
              gap: 12
            }}>
              <FileCode className="w-16 h-16 opacity-20" />
              <p>Select a file to edit</p>
            </div>
          )}
        </div>
      </div>

      {/* Status Bar */}
      {(compilationStatus || deploymentStatus || error) && (
        <div style={{
          borderTop: '1px solid #374151',
          padding: '8px 16px',
          background: '#111827',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontSize: '13px'
        }}>
          {error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#ef4444' }}>
              <AlertCircle className="w-4 h-4" />
              <span>{error}</span>
              <button onClick={() => setError(null)} style={{ marginLeft: 8 }}>
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          
          {compilationStatus && (
            <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: 6,
              color: compilationStatus.status === 'error' ? '#ef4444' : 
                     compilationStatus.status === 'success' ? '#22c55e' : '#eab308'
            }}>
              {compilationStatus.status === 'compiling' && <RefreshCw className="w-4 h-4 animate-spin" />}
              {compilationStatus.status === 'success' && <CheckCircle className="w-4 h-4" />}
              {compilationStatus.status === 'error' && <AlertCircle className="w-4 h-4" />}
              <span>{compilationStatus.message}</span>
            </div>
          )}
          
          {deploymentStatus && !compilationStatus && (
            <div style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: 6,
              color: deploymentStatus.status === 'error' ? '#ef4444' : 
                     deploymentStatus.status === 'success' ? '#22c55e' : '#3b82f6'
            }}>
              {deploymentStatus.status === 'deploying' && <RefreshCw className="w-4 h-4 animate-spin" />}
              {deploymentStatus.status === 'success' && <CheckCircle className="w-4 h-4" />}
              {deploymentStatus.status === 'error' && <AlertCircle className="w-4 h-4" />}
              <span>{deploymentStatus.message}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
