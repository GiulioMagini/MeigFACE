<script lang="ts">
  //! Stylized outline of the 2D puppet, rendered at the exact position
  //! and size the real avatar will occupy during normal use.
  //!
  //! Shown during the eye-anchor phase of calibration and in the
  //! calibration test view, so the user learns where the character
  //! will be and where its eyes are. Geometry (placement, eyes) comes
  //! from the shared layout module — the same one that generates the
  //! anchor calibration points — so outline and targets can never
  //! drift apart.

  import {
    PUPPET_VIEWBOX,
    PUPPET_LEFT_EYE,
    PUPPET_RIGHT_EYE,
    PUPPET_HEIGHT_FRACTION,
  } from "$lib/avatar/layout";

  interface Props {
    /** Pick the stroke that contrasts with the host view background. */
    variant?: "onDark" | "onLight";
  }

  let { variant = "onDark" }: Props = $props();
</script>

<!--
  The wrapper replicates puppetRect() in pure CSS (bottom-anchored,
  horizontally centered, height = fraction of viewport height) so the
  overlay needs no resize listeners; the SVG scales with its viewBox.
-->
<div
  class="silhouette"
  class:on-light={variant === "onLight"}
  style="height: {PUPPET_HEIGHT_FRACTION * 100}vh;"
  aria-hidden="true"
>
  <svg
    viewBox="0 0 {PUPPET_VIEWBOX.width} {PUPPET_VIEWBOX.height}"
    preserveAspectRatio="xMidYMax meet"
  >
    <!-- head outline: same face path as the real puppets -->
    <path
      d="M180 70
         q70 0 78 86
         q5 64 -28 102
         q-22 26 -50 26
         q-28 0 -50 -26
         q-33 -38 -28 -102
         q8 -86 78 -86 Z"
    />
    <!-- hair dome hint -->
    <path d="M104 150 Q96 60 180 52 Q264 60 256 150" />
    <!-- neck -->
    <path d="M150 286 L153 318 M210 286 L207 318" />
    <!-- shoulders -->
    <path d="M44 378 Q48 330 118 318 L150 312 M210 312 L242 318 Q312 330 316 378" />
    <!-- eyes: the actual gaze target band -->
    <ellipse
      cx={PUPPET_LEFT_EYE.x}
      cy={PUPPET_LEFT_EYE.y}
      rx="20"
      ry="13"
    />
    <ellipse
      cx={PUPPET_RIGHT_EYE.x}
      cy={PUPPET_RIGHT_EYE.y}
      rx="20"
      ry="13"
    />
  </svg>
</div>

<style>
  .silhouette {
    position: fixed;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    /* width follows from height via the SVG aspect ratio */
    aspect-ratio: 360 / 378;
    pointer-events: none;
    z-index: 1;
    color: rgba(255, 255, 255, 0.45);
  }

  .silhouette.on-light {
    color: rgba(0, 0, 0, 0.35);
  }

  .silhouette svg {
    width: 100%;
    height: 100%;
  }

  .silhouette path,
  .silhouette ellipse {
    fill: none;
    stroke: currentColor;
    stroke-width: 2.5;
    stroke-dasharray: 7 7;
    stroke-linecap: round;
  }
</style>