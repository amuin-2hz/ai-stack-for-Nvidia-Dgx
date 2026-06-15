/*
# SPDX-FileCopyrightText: Copyright (c) 1993-2025 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
*/
"use client";
import { useState, useRef, useEffect } from 'react';
import QuerySection from '@/components/QuerySection';
import DocumentIngestion from '@/components/DocumentIngestion';
import styles from '@/styles/Home.module.css';
import workbench from '@/styles/Workbench.module.css';

type View = "models" | "running" | "chat";

type CompatInfo = {
  status: string;
  reason: string;
};

type ModelRecord = {
  id: string;
  display_name: string;
  capabilities: string[];
  local: {
    path: string;
    layout: string;
    format: string;
    size_bytes: number;
    file_count: number;
    weight_files: number;
    config_files: string[];
  };
  runtime: {
    preferred: string;
    supported: string[];
  };
  compatibility: Record<string, CompatInfo>;
  status: {
    download: string;
    deploy: string;
    health: string;
  };
};

type DeploymentRecord = {
  deployment_id: string;
  status: string;
  service_type: string;
  runtime: string;
  container_name?: string;
  public_port: number;
  base_url: string;
  health_url: string;
  openai_models: string[];
  warnings: string[];
};

type SystemCheck = {
  management_url: string;
  backend_url: string;
  docker?: {
    ok: boolean;
    detail: string;
  };
};

type DeploymentPlan = {
  deployment_id: string;
  status: string;
  service_type: string;
  compatibility?: CompatInfo;
  launch?: {
    command: string;
    working_directory: string;
    notes: string[];
  };
};

const formatBytes = (value: number) => {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const statusClass = (status: string) => {
  if (status === "compatible" || status === "ready" || status === "configured") return workbench.badgeGood;
  if (status === "unsupported" || status === "incomplete") return workbench.badgeBlocked;
  return workbench.badgeWarn;
};

export default function Home() {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState("[]");
  const [files, setFiles] = useState<FileList | null>(null);
  const [ingestMessage, setIngestMessage] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isIngesting, setIsIngesting] = useState(false);
  const [showIngestion, setShowIngestion] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [view, setView] = useState<View>("models");
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [systemCheck, setSystemCheck] = useState<SystemCheck | null>(null);
  const [modelUrl, setModelUrl] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [deploymentPlans, setDeploymentPlans] = useState<Record<string, string>>({});
  const abortControllerRef = useRef<AbortController | null>(null);

  // Load initial chat ID
  useEffect(() => {
    const fetchCurrentChatId = async () => {
      try {
        const response = await fetch("/api/chat_id");
        if (response.ok) {
          const { chat_id } = await response.json();
          setCurrentChatId(chat_id);
        }
      } catch (error) {
        console.error("Error fetching current chat ID:", error);
      }
    };
    fetchCurrentChatId();
  }, []);

  useEffect(() => {
    const loadWorkbench = async () => {
      try {
        const [modelsResponse, deploymentsResponse, systemResponse] = await Promise.all([
          fetch("/api/models"),
          fetch("/api/deployments"),
          fetch("/api/system/check"),
        ]);
        if (modelsResponse.ok) {
          const payload = await modelsResponse.json();
          setModels(payload.models ?? []);
        }
        if (deploymentsResponse.ok) {
          const payload = await deploymentsResponse.json();
          setDeployments(payload.deployments ?? []);
        }
        if (systemResponse.ok) {
          setSystemCheck(await systemResponse.json());
        }
      } catch (error) {
        console.error("Error loading workbench data:", error);
      }
    };
    loadWorkbench();
  }, [refreshTrigger]);

  // Clean up any ongoing streams when component unmounts
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Function to handle successful document ingestion
  const handleSuccessfulIngestion = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  const handleImport = async () => {
    if (!modelUrl.trim()) return;
    setImportMessage("Parsing model source...");
    try {
      const response = await fetch("/api/models/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: modelUrl.trim(), provider: "auto" }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setImportMessage(payload.detail ?? "Import parsing failed.");
        return;
      }
      setImportMessage([
        "Parsed " + payload.model.provider + ":" + payload.model.repo_id,
        "Target: " + payload.model.target_path,
        payload.download?.working_directory ? "Workdir: " + payload.download.working_directory : "",
        payload.download?.command ? "Command: " + payload.download.command : payload.message
      ].filter(Boolean).join("\n"));
    } catch (error) {
      setImportMessage(`Import parsing failed: ${String(error)}`);
    }
  };

  const handlePlanDeployment = async (model: ModelRecord, serviceType: string) => {
    const key = model.id + ":" + serviceType;
    setDeploymentPlans((prev) => ({ ...prev, [key]: "Planning deployment..." }));
    try {
      const response = await fetch("/api/deployments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_id: model.id, service_type: serviceType, openai_model: model.id }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setDeploymentPlans((prev) => ({ ...prev, [key]: payload.detail ?? "Deployment is not compatible." }));
        return;
      }
      const plan = payload as DeploymentPlan;
      const lines = [
        "Plan: " + plan.deployment_id + " (" + plan.status + ")",
        plan.compatibility ? "Compatibility: " + plan.compatibility.status + " - " + plan.compatibility.reason : "",
        plan.launch?.working_directory ? "Workdir: " + plan.launch.working_directory : "",
        plan.launch?.command ? "Command: " + plan.launch.command : "",
        ...(plan.launch?.notes ?? [])
      ].filter(Boolean);
      setDeploymentPlans((prev) => ({ ...prev, [key]: lines.join("\n") }));
    } catch (error) {
      setDeploymentPlans((prev) => ({ ...prev, [key]: "Deployment planning failed: " + String(error) }));
    }
  };

  const renderModels = () => (
    <>
      <div className={workbench.header}>
        <div>
          <div className={workbench.eyebrow}>Model Registry</div>
          <h1 className={workbench.title}>Local model workbench</h1>
          <p className={workbench.subtle}>vLLM-first audit, service routing, and compatibility hints for the current AI Stack host.</p>
        </div>
        <div className={workbench.toolbar}>
          <input
            className={workbench.input}
            value={modelUrl}
            onChange={(event) => setModelUrl(event.target.value)}
            placeholder="Paste Hugging Face or ModelScope model URL"
          />
          <button className={workbench.button} onClick={handleImport}>Import</button>
          <button className={`${workbench.button} ${workbench.buttonSecondary}`} onClick={() => setRefreshTrigger(prev => prev + 1)}>Refresh</button>
        </div>
      </div>
      {importMessage && <div className={workbench.empty}>{importMessage}</div>}
      <div className={workbench.grid}>
        {models.map((model) => (
          <article className={workbench.card} key={model.id}>
            <div className={workbench.cardHeader}>
              <div>
                <div className={workbench.cardTitle}>{model.display_name}</div>
                <div className={workbench.subtle}>{model.local.path}</div>
              </div>
              <span className={`${workbench.badge} ${statusClass(model.status.download)}`}>{model.status.download}</span>
            </div>
            <div className={workbench.metaGrid}>
              <div><div className={workbench.metaLabel}>Format</div><div className={workbench.metaValue}>{model.local.format}</div></div>
              <div><div className={workbench.metaLabel}>Layout</div><div className={workbench.metaValue}>{model.local.layout}</div></div>
              <div><div className={workbench.metaLabel}>Size</div><div className={workbench.metaValue}>{formatBytes(model.local.size_bytes)}</div></div>
              <div><div className={workbench.metaLabel}>Runtime</div><div className={workbench.metaValue}>{model.runtime.preferred}</div></div>
              <div><div className={workbench.metaLabel}>Capabilities</div><div className={workbench.metaValue}>{model.capabilities.join(", ")}</div></div>
              <div><div className={workbench.metaLabel}>Files</div><div className={workbench.metaValue}>{model.local.file_count} files, {model.local.weight_files} weights</div></div>
            </div>
            <div className={workbench.compat}>
              {["vllm", "trtllm", "audio", "lmstudio"].map((service) => {
                const compat = model.compatibility[service];
                return compat ? (
                  <div className={workbench.compatRow} key={service}>
                    <strong>{service}</strong>
                    <span className={`${workbench.badge} ${statusClass(compat.status)}`}>{compat.status}</span>
                    <span>{compat.reason}</span>
                  </div>
                ) : null;
              })}
            </div>
            <div className={workbench.actions}>
              {["vllm", "trtllm", "audio"].map((service) => {
                const compat = model.compatibility[service];
                const disabled = !compat || compat.status === "unsupported";
                return (
                  <button
                    className={`${workbench.button} ${workbench.buttonSecondary}`}
                    disabled={disabled}
                    key={service}
                    onClick={() => handlePlanDeployment(model, service)}
                  >
                    Plan {service}
                  </button>
                );
              })}
            </div>
            {["vllm", "trtllm", "audio"].map((service) => {
              const key = model.id + ":" + service;
              return deploymentPlans[key] ? <pre className={workbench.plan} key={key}>{deploymentPlans[key]}</pre> : null;
            })}
          </article>
        ))}
      </div>
      {!models.length && <div className={workbench.empty}>No local models found under the configured models directory.</div>}
    </>
  );

  const renderRunning = () => (
    <>
      <div className={workbench.header}>
        <div>
          <div className={workbench.eyebrow}>Services</div>
          <h1 className={workbench.title}>Running and planned endpoints</h1>
          <p className={workbench.subtle}>Public inference ports are service-type ports in the 30000-60000 range.</p>
        </div>
        <button className={`${workbench.button} ${workbench.buttonSecondary}`} onClick={() => setRefreshTrigger(prev => prev + 1)}>Refresh</button>
      </div>
      <div className={workbench.grid}>
        {deployments.map((deployment) => (
          <article className={workbench.card} key={deployment.deployment_id}>
            <div className={workbench.cardHeader}>
              <div>
                <div className={workbench.cardTitle}>{deployment.service_type}</div>
                <div className={workbench.subtle}>{deployment.runtime}</div>
              </div>
              <span className={`${workbench.badge} ${statusClass(deployment.status)}`}>{deployment.status}</span>
            </div>
            <div className={workbench.metaGrid}>
              <div><div className={workbench.metaLabel}>Public port</div><div className={workbench.metaValue}>{deployment.public_port}</div></div>
              <div><div className={workbench.metaLabel}>Container</div><div className={workbench.metaValue}>{deployment.container_name ?? "n/a"}</div></div>
              <div><div className={workbench.metaLabel}>Base URL</div><div className={workbench.metaValue}>{deployment.base_url}</div></div>
              <div><div className={workbench.metaLabel}>Health</div><div className={workbench.metaValue}>{deployment.health_url}</div></div>
            </div>
            {deployment.openai_models.length > 0 && <div className={workbench.subtle}>Models: {deployment.openai_models.join(", ")}</div>}
            {deployment.warnings.map((warning) => <div className={workbench.empty} key={warning}>{warning}</div>)}
          </article>
        ))}
      </div>
      {systemCheck && (
        <div className={workbench.card} style={{ marginTop: 12 }}>
          <div className={workbench.cardTitle}>System check</div>
          <div className={workbench.metaGrid}>
            <div><div className={workbench.metaLabel}>Management</div><div className={workbench.metaValue}>{systemCheck.management_url}</div></div>
            <div><div className={workbench.metaLabel}>API</div><div className={workbench.metaValue}>{systemCheck.backend_url}</div></div>
            <div><div className={workbench.metaLabel}>Docker</div><div className={workbench.metaValue}>{systemCheck.docker?.ok ? "ready" : "needs attention"}</div></div>
            <div><div className={workbench.metaLabel}>Docker detail</div><div className={workbench.metaValue}>{systemCheck.docker?.detail}</div></div>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className={workbench.shell}>
      <aside className={workbench.rail}>
        <div className={workbench.brand}>
          <div className={workbench.brandName}>AMUIN AI STACK</div>
          <div className={workbench.brandMeta}>localhost:8888</div>
        </div>
        <nav className={workbench.nav}>
          {(["models", "running", "chat"] as View[]).map((item) => (
            <button
              className={`${workbench.navButton} ${view === item ? workbench.navButtonActive : ""}`}
              key={item}
              onClick={() => setView(item)}
            >
              {item === "models" ? "Models" : item === "running" ? "Running" : "Chat"}
            </button>
          ))}
        </nav>
        <div className={workbench.railFooter}>
          <div>vLLM {systemCheck ? "30000" : "..."}</div>
          <div>TensorRT-LLM {systemCheck ? "31000" : "..."}</div>
          <div>Audio {systemCheck ? "32000" : "..."}</div>
        </div>
      </aside>

      <div className={workbench.content}>
        {view === "models" && renderModels()}
        {view === "running" && renderRunning()}
        {view === "chat" && (
          <div className={workbench.chatPane}>
            <QuerySection
              query={query}
              response={response}
              isStreaming={isStreaming}
              setQuery={setQuery}
              setResponse={setResponse}
              setIsStreaming={setIsStreaming}
              abortControllerRef={abortControllerRef}
              setShowIngestion={setShowIngestion}
              currentChatId={currentChatId}
            />
          </div>
        )}
      </div>

      {showIngestion && (
        <>
          <div className={styles.overlay} onClick={() => setShowIngestion(false)} />
          <div className={styles.documentUploadContainer}>
            <button 
              className={styles.closeButton} 
              onClick={() => setShowIngestion(false)}
            >
              ×
            </button>
            <DocumentIngestion
              files={files}
              ingestMessage={ingestMessage}
              isIngesting={isIngesting}
              setFiles={setFiles}
              setIngestMessage={setIngestMessage}
              setIsIngesting={setIsIngesting}
              onSuccessfulIngestion={handleSuccessfulIngestion}
            />
          </div>
        </>
      )}
    </div>
  );
}
