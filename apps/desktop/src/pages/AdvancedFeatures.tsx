import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface AdvancedFeaturesProps {
  onClose: () => void;
}

export function AdvancedFeatures({ onClose }: AdvancedFeaturesProps) {
  const [shares, setShares] = useState<number[][]>([]);
  const [shareUrl, setShareUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string>('');

  const testShamir = async () => {
    setLoading(true);
    try {
      const secret = new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24]);
      const result = await invoke('generate_shamir_shares', {
        payload: { secret: Array.from(secret), n: 3, k: 2 }
      });
      setShares(result as number[][]);
      setResult('✅ Fragments générés !');
    } catch (e) {
      setResult(`❌ Erreur : ${e}`);
    } finally {
      setLoading(false);
    }
  };

  const testTempShare = async () => {
    setLoading(true);
    try {
      const data = new TextEncoder().encode('Mon secret temporaire');
      const url = await invoke('create_temp_share', {
        plaintext: Array.from(data),
        ttl_seconds: 3600
      });
      setShareUrl(url as string);
      setResult(`✅ URL créée : ${url}`);
    } catch (e) {
      setResult(`❌ Erreur : ${e}`);
    } finally {
      setLoading(false);
    }
  };

  const testAutoType = async () => {
    setLoading(true);
    try {
      await invoke('auto_type', {
        payload: {
          username: 'test@example.com',
          password: 'MonMotDePasse123',
          entry_id: 'test-123'
        }
      });
      setResult('✅ Auto-Type simulé (regardez votre clavier)');
    } catch (e) {
      setResult(`❌ Erreur : ${e}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-surface rounded-2xl shadow-2xl border border-edge max-w-xl w-full max-h-[90vh] overflow-y-auto p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-display">⚡ Fonctionnalités avancées</h2>
          <button onClick={onClose} className="text-muted hover:text-primary text-xl">✕</button>
        </div>

        <div className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <button
              onClick={testShamir}
              disabled={loading}
              className="px-4 py-2 bg-brand/10 text-accent-strong rounded-lg border border-brand/30 hover:bg-brand/20 transition-colors disabled:opacity-50"
            >
              📜 Générer fragments Shamir
            </button>
            <button
              onClick={testTempShare}
              disabled={loading}
              className="px-4 py-2 bg-brand/10 text-accent-strong rounded-lg border border-brand/30 hover:bg-brand/20 transition-colors disabled:opacity-50"
            >
              🔗 Partager un secret
            </button>
            <button
              onClick={testAutoType}
              disabled={loading}
              className="px-4 py-2 bg-brand/10 text-accent-strong rounded-lg border border-brand/30 hover:bg-brand/20 transition-colors disabled:opacity-50"
            >
              ⌨️ Simuler auto-type
            </button>
          </div>

          {loading && <p className="text-sm text-muted">⏳ En cours...</p>}
          {result && <p className="text-sm bg-surface-2 p-3 rounded-lg border border-edge">{result}</p>}

          {shares.length > 0 && (
            <div className="bg-surface-2 p-3 rounded-lg border border-edge">
              <p className="text-xs text-muted mb-1">Fragments :</p>
              <pre className="text-xs overflow-auto">{JSON.stringify(shares, null, 2)}</pre>
            </div>
          )}

          {shareUrl && (
            <div className="bg-surface-2 p-3 rounded-lg border border-edge">
              <p className="text-xs text-muted mb-1">URL de partage :</p>
              <a href={shareUrl} target="_blank" rel="noopener noreferrer" className="text-accent break-all text-sm">{shareUrl}</a>
            </div>
          )}

          <p className="text-xs text-muted mt-4 border-t border-edge pt-4">
            ⚠️ Ces fonctionnalités sont en phase de test. Les résultats sont affichés ici.
          </p>
        </div>
      </div>
    </div>
  );
}
