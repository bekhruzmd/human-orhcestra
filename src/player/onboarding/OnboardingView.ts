/**
 * Gravitate Onboarding View (Phase 2: Web Profile Generation)
 *
 * Merges the "Bump/Hey-" social icebreaker with the Human Orchestra 8-bit aesthetic.
 *
 * UX Flow:
 * // 1. Prompt user for microphone access / text input.
 * // 2. Capture a short intro.
 * // 3. (Optional) AI asks 1-3 follow up questions.
 * // 4. Generate structured profile.
 * // 5. User edits and APPROVES profile before saving to localStorage.
 *
 * UX Directives:
 * - User Control: Profile is NEVER broadcast until user explicitly clicks "APPROVE & ENTER".
 * - Offline Safety: Approved profile is stored in localStorage ('gravitate.profile').
 * - Vibe & Styling: 100% consistent with Human Orchestra's 8-bit / neon rhythm game aesthetic.
 */

export interface GravitateProfile {
  id?: string;
  name: string;
  tagline: string;
  bio: string;
  interests: string[];
  musicTaste: string[];
  vibe: string;
  icebreakers: string[];
  approved: boolean;
  approvedAt?: number;
}

export type OnboardingStep = 'input' | 'loading' | 'review';

export const STORAGE_KEY = 'gravitate.profile';

export class OnboardingView {
  private container: HTMLElement;
  private rootEl: HTMLElement | null = null;
  private currentStep: OnboardingStep = 'input';
  private introInput: string = '';
  private profile: GravitateProfile | null = null;
  private onApprovedCallback: ((profile: GravitateProfile) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  /**
   * Offline safety: Check and retrieve approved profile from localStorage.
   */
  public static getStoredProfile(): GravitateProfile | null {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (!data) return null;
      const parsed = JSON.parse(data) as GravitateProfile;
      return parsed.approved ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Save approved profile to localStorage.
   */
  public static saveProfile(profile: GravitateProfile): void {
    try {
      profile.approved = true;
      profile.approvedAt = Date.now();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    } catch (err) {
      console.warn('[Gravitate] Error writing profile to localStorage:', err);
    }
  }

  /**
   * Clear stored profile (e.g. for reset).
   */
  public static clearProfile(): void {
    localStorage.removeItem(STORAGE_KEY);
  }

  /**
   * Register callback fired when user explicitly approves their profile.
   */
  public onApproved(callback: (profile: GravitateProfile) => void): void {
    this.onApprovedCallback = callback;
  }

  /**
   * Mount into container.
   */
  public mount(): void {
    if (!this.rootEl) {
      this.rootEl = document.createElement('div');
      this.rootEl.className = 'gravitate-onboarding-screen';
      this.container.appendChild(this.rootEl);
    }
    this.render();
  }

  /**
   * Unmount from container.
   */
  public unmount(): void {
    if (this.rootEl && this.rootEl.parentElement) {
      this.rootEl.parentElement.removeChild(this.rootEl);
    }
    this.rootEl = null;
  }

  /**
   * Render active step with 8-bit / neon rhythm game UI.
   */
  public render(): void {
    if (!this.rootEl) return;

    this.rootEl.innerHTML = '';
    const card = document.createElement('div');
    card.className = 'gravitate-card';

    switch (this.currentStep) {
      case 'input':
        card.appendChild(this.renderInputScreen());
        break;
      case 'loading':
        card.appendChild(this.renderLoadingScreen());
        break;
      case 'review':
        card.appendChild(this.renderReviewScreen());
        break;
    }

    this.rootEl.appendChild(card);
  }

  // ------------------------------------------------------------- Screen A: Input

  /**
   * Screen A (Input):
   * // 1. Prompt user for microphone access / text input.
   * // 2. Capture a short intro.
   */
  private renderInputScreen(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'gravitate-step step-input';
    el.innerHTML = `
      <div class="pixel-badge">GRAVITATE · AI ONBOARDING</div>
      <h1 class="pixel-title">CREATE YOUR PERSONA</h1>
      <p class="pixel-subtitle">HUMAN ORCHESTRA 8-BIT ICEBREAKER</p>

      <div class="intro-box">
        <label for="gravitate-intro-text" class="form-label">Who are you? (Type a quick intro...)</label>
        <textarea
          id="gravitate-intro-text"
          class="pixel-textarea"
          placeholder="E.g., I love synthesizers, chiptune rhythms, sci-fi movies, and playing bass in rhythm games..."
          spellcheck="false"
        >${this.introInput}</textarea>
        <div class="loading-hint">Gemini 3.6 Flash will synthesize your music taste & icebreaker tags.</div>
      </div>

      <div class="action-grid">
        <button id="btn-generate" class="pixel-btn btn-pink approve-btn">
          ⚡ GENERATE 8-BIT PERSONA
        </button>
      </div>
    `;

    const textarea = el.querySelector('#gravitate-intro-text') as HTMLTextAreaElement;
    textarea?.addEventListener('input', (e) => {
      this.introInput = (e.target as HTMLTextAreaElement).value;
    });

    // Support Cmd+Enter / Ctrl+Enter shortcut
    textarea?.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        el.querySelector<HTMLButtonElement>('#btn-generate')?.click();
      }
    });

    el.querySelector('#btn-generate')?.addEventListener('click', () => {
      const text = this.introInput.trim();
      if (!text) {
        textarea?.focus();
        return;
      }
      this.triggerGenerateProfile(text);
    });

    return el;
  }

  // ----------------------------------------------------------- Screen B: Loading

  /**
   * Screen B (Loading):
   * Retro "ANALYZING VIBE..." loading state.
   */
  private renderLoadingScreen(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'gravitate-step step-loading';
    el.innerHTML = `
      <div class="loading-box">
        <div class="pixel-badge">GEMINI 3.6 FLASH</div>
        <div class="analyzing-title">ANALYZING VIBE…</div>
        <div class="retro-progress">
          <div class="retro-progress-bar"></div>
        </div>
        <div class="loading-hint">SYNTHESIZING 8-BIT RHYTHM PROFILE</div>
      </div>
    `;
    return el;
  }

  // ------------------------------------------------------------ Screen C: Review

  /**
   * Screen C (Review):
   * // 4. Generate structured profile.
   * // 5. User edits and APPROVES profile before saving to localStorage.
   */
  private renderReviewScreen(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'gravitate-step step-review';
    const p = this.profile || this.createFallbackProfile('PixelPlayer');

    const interestsStr = (p.interests || []).join(', ');
    const musicStr = (p.musicTaste || []).join(', ');

    el.innerHTML = `
      <div class="pixel-badge">STEP 2: REVIEW & APPROVE</div>
      <h2 class="pixel-title">YOUR 8-BIT PERSONA</h2>
      <p class="hint-text">Edit any details below. Your profile remains private until you approve.</p>

      <div class="review-form">
        <div class="form-group">
          <label class="form-label" for="edit-name">Arcade Handle / Name</label>
          <input id="edit-name" class="pixel-field" value="${this.escapeHtml(p.name)}" maxlength="14" />
        </div>

        <div class="form-group">
          <label class="form-label" for="edit-tagline">Tagline</label>
          <input id="edit-tagline" class="pixel-field" value="${this.escapeHtml(p.tagline)}" />
        </div>

        <div class="form-group">
          <label class="form-label" for="edit-bio">Bio</label>
          <textarea id="edit-bio" class="pixel-field" rows="2" style="resize:none;">${this.escapeHtml(p.bio)}</textarea>
        </div>

        <div class="form-group">
          <label class="form-label" for="edit-interests">Interests (comma separated)</label>
          <input id="edit-interests" class="pixel-field" value="${this.escapeHtml(interestsStr)}" />
        </div>

        <div class="form-group">
          <label class="form-label" for="edit-music">Music Taste & Vibes</label>
          <input id="edit-music" class="pixel-field" value="${this.escapeHtml(musicStr)}" />
        </div>

        <div class="form-group">
          <label class="form-label" for="edit-vibe">Aesthetic Vibe</label>
          <input id="edit-vibe" class="pixel-field" value="${this.escapeHtml(p.vibe)}" />
        </div>

        ${
          p.icebreakers && p.icebreakers.length > 0
            ? `
          <div class="form-group">
            <label class="form-label">Icebreakers for Other Players</label>
            <div class="icebreaker-list">
              ${p.icebreakers
                .map((q) => `<div class="icebreaker-bubble">💬 "${this.escapeHtml(q)}"</div>`)
                .join('')}
            </div>
          </div>
        `
            : ''
        }
      </div>

      <div class="action-grid" style="margin-top: 10px;">
        <button id="btn-redo" class="pixel-btn btn-butter">↺ REDO</button>
        <button id="btn-approve-enter" class="pixel-btn btn-mint approve-btn">
          ★ APPROVE & ENTER
        </button>
      </div>
    `;

    el.querySelector('#btn-redo')?.addEventListener('click', () => {
      this.currentStep = 'input';
      this.render();
    });

    el.querySelector('#btn-approve-enter')?.addEventListener('click', () => {
      const nameInput = el.querySelector<HTMLInputElement>('#edit-name');
      const taglineInput = el.querySelector<HTMLInputElement>('#edit-tagline');
      const bioInput = el.querySelector<HTMLTextAreaElement>('#edit-bio');
      const interestsInput = el.querySelector<HTMLInputElement>('#edit-interests');
      const musicInput = el.querySelector<HTMLInputElement>('#edit-music');
      const vibeInput = el.querySelector<HTMLInputElement>('#edit-vibe');

      const approvedProfile: GravitateProfile = {
        id: p.id || 'usr_' + Math.random().toString(36).slice(2, 9),
        name: (nameInput?.value.trim() || p.name || 'PixelPlayer').slice(0, 14),
        tagline: taglineInput?.value.trim() || p.tagline,
        bio: bioInput?.value.trim() || p.bio,
        interests: interestsInput?.value
          ? interestsInput.value.split(',').map((s) => s.trim()).filter(Boolean)
          : p.interests,
        musicTaste: musicInput?.value
          ? musicInput.value.split(',').map((s) => s.trim()).filter(Boolean)
          : p.musicTaste,
        vibe: vibeInput?.value.trim() || p.vibe,
        icebreakers: p.icebreakers || [],
        approved: true,
        approvedAt: Date.now(),
      };

      // 5. User edits and APPROVES profile before saving to localStorage.
      OnboardingView.saveProfile(approvedProfile);
      this.profile = approvedProfile;
      this.unmount();

      if (this.onApprovedCallback) {
        this.onApprovedCallback(approvedProfile);
      }
    });

    return el;
  }

  // ------------------------------------------------------------- AI Generation

  private async triggerGenerateProfile(text: string): Promise<void> {
    this.currentStep = 'loading';
    this.render();

    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: text }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => null);
        console.warn('[Gravitate] API returned status', res.status, errorData);
        this.profile = errorData?.fallback || this.createFallbackProfile(text);
      } else {
        const profileData = await res.json();
        this.profile = profileData;
      }
    } catch (err) {
      console.warn('[Gravitate] Network error contacting /api/profile, using fallback persona:', err);
      this.profile = this.createFallbackProfile(text);
    }

    this.currentStep = 'review';
    this.render();
  }

  private createFallbackProfile(input: string): GravitateProfile {
    const firstWord = input.trim().split(/\s+/)[0]?.replace(/[^a-zA-Z0-9]/g, '') || 'NeonRider';
    return {
      id: 'usr_' + Math.random().toString(36).slice(2, 9),
      name: firstWord.slice(0, 12) || 'PixelHero',
      tagline: 'Dropping 8-bit rhythms in the Human Orchestra',
      bio: input.trim() || 'A rhythm enthusiast ready to jam in sync.',
      interests: ['Synthesizers', 'Chiptune Games', 'Co-op Jamming'],
      musicTaste: ['Synthwave', '8-Bit Chiptune', 'Electronic'],
      vibe: 'Arcade Neon Maverick',
      icebreakers: [
        'What was the first rhythm game that hooked you?',
        'If your personality was a synth instrument, would you be lead, keys, bass, or drums?',
      ],
      approved: false,
    };
  }

  private escapeHtml(str: string): string {
    return (str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
