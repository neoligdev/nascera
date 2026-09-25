// Cinetica Webflow custom code (migrado desde Slater)
// Última actualización: 2026-02-03


function initCookieConsent() {

  const STORAGE_KEY = "cookie_consent_accepted";

  const modalGroup = document.querySelector('[data-cookie-modal="group"]');
  const modalCard = document.querySelector('[data-cookie-modal="card"]');
  const acceptBtn = document.querySelector('[data-cookie-accept]');

  if (!modalGroup || !modalCard || !acceptBtn) return;

  // Check if user already accepted cookies
  const hasConsent = localStorage.getItem(STORAGE_KEY) === "true";

  if (!hasConsent) {
    openModal();
  }

  // Accept cookies
  acceptBtn.addEventListener("click", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    closeModal();
  });

  // Open modal
  function openModal() {
    modalGroup.setAttribute("data-modal-group-status", "active");
    modalCard.setAttribute("data-modal-status", "active");
    document.body.style.overflow = "hidden";
  }

  // Close modal
  function closeModal() {
    modalGroup.setAttribute("data-modal-group-status", "not-active");
    modalCard.setAttribute("data-modal-status", "not-active");
    document.body.style.overflow = "";
  }
}

CustomEase.create("button-ease", "0.5, 0.05, 0.05, 0.99");

let resetHamburger;

function initMenuButton() {
  const menuButton = document.querySelector("[data-menu-button]");
  if (!menuButton) return;

  const lines = menuButton.querySelectorAll(".menu-button-line");
  const [line1, line2, line3] = lines;

  let menuButtonTl = gsap.timeline({
    defaults: {
      overwrite: "auto",
      ease: "button-ease", // Mantenemos tu ease personalizado
      duration: 0.3
    }
  });

  const menuOpen = () => {
    menuButtonTl.clear()
      .to(line2, { scaleX: 0, opacity: 0 })
      .to(line1, { x: "-1.3em", opacity: 0 }, "<")
      .to(line3, { x: "1.3em", opacity: 0 }, "<")
      .to([line1, line3], { opacity: 0, duration: 0.1 }, "<+=0.2")
      .set(line1, { rotate: -135, y: "-1.3em", scaleX: 0.9 })
      .set(line3, { rotate: 135, y: "-1.4em", scaleX: 0.9 }, "<")
      .to(line1, { opacity: 1, x: "0em", y: "0.5em" })
      .to(line3, { opacity: 1, x: "0em", y: "-0.25em" }, "<+=0.1");

    menuButton.setAttribute("data-menu-button", "close");
  };

  const menuClose = () => {
    menuButtonTl.clear()
      .to([line1, line2, line3], {
        scaleX: 1,
        rotate: 0,
        x: "0em",
        y: "0em",
        opacity: 1,
        duration: 0.45
      });

    menuButton.setAttribute("data-menu-button", "burger");
  };

  // Asignamos la función a la variable global para que initMenu la vea
  resetHamburger = menuClose;

  menuButton.addEventListener("click", () => {
    const state = menuButton.getAttribute("data-menu-button");
    state === "burger" ? menuOpen() : menuClose();
  });
}

function initMenu() {
  const body = document.body;

  const openMenu = () => {
    body.setAttribute("data-menu-status", "open");
    if (typeof lenis !== 'undefined') lenis.stop();
  };

  const closeMenu = () => {
    body.setAttribute("data-menu-status", "closed");
    if (typeof lenis !== 'undefined') lenis.start();

    // Sincronización: Si el menú se cierra por fuera, reseteamos la hamburguesa
    if (typeof resetHamburger === "function") {
      resetHamburger();
    }
  };

  const toggleMenu = () => {
    body.getAttribute("data-menu-status") === "open" ? closeMenu() : openMenu();
  };

  document.querySelectorAll("[data-menu-toggle]").forEach(el => {
    el.addEventListener("click", e => {
      const action = el.getAttribute("data-menu-toggle");
      const href = el.getAttribute("href");

      if (href && href.startsWith("#")) {
        e.preventDefault();
        const target = document.querySelector(href);
        if (!target) return;

        closeMenu(); // Esto ya ejecuta el reset de la hamburguesa
        setTimeout(() => {
          if (typeof lenis !== 'undefined') lenis.scrollTo(target);
        }, 400);
        return;
      }

      if (action === "toggle") {
        e.preventDefault();
        toggleMenu();
      }

      if (action === "close") {
        closeMenu();
      }
    });
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && body.getAttribute("data-menu-status") === "open") {
      closeMenu();
    }
  });
}

function initBasicCustomCursor() {
  gsap.set(".cursor", { xPercent: -50, yPercent: -50 });

  const xTo = gsap.quickTo(".cursor", "x", {
    duration: 0.6,
    ease: "power3"
  });

  const yTo = gsap.quickTo(".cursor", "y", {
    duration: 0.6,
    ease: "power3"
  });

  window.addEventListener("mousemove", (e) => {
    xTo(e.clientX);
    yTo(e.clientY);
  });
}

function initDynamicCurrentTime() {
  const defaultTimezone = "America/Mexico_City";

  // Helper function to format numbers with leading zero
  const formatNumber = (number) => number.toString().padStart(2, '0');

  // Function to create a time formatter with the correct timezone
  const createFormatter = (timezone) => {
    return new Intl.DateTimeFormat([], {
      timeZone: timezone,
      timeZoneName: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false, // Optional: Remove to match your simpler script
    });
  };

  // Function to parse the formatted string into parts
  const parseFormattedTime = (formattedDateTime) => {
    const match = formattedDateTime.match(/(\d+):(\d+):(\d+)\s*([\w+]+)/);
    if (match) {
      return {
        hours: match[1],
        minutes: match[2],
        seconds: match[3],
        timezone: match[4], // Handles both GMT+X and CET cases
      };
    }
    return null;
  };

  // Function to update the time for all elements
  const updateTime = () => {
    document.querySelectorAll('[data-current-time]').forEach((element) => {
      const timezone = element.getAttribute('data-current-time') || defaultTimezone;
      const formatter = createFormatter(timezone);
      const now = new Date();
      const formattedDateTime = formatter.format(now);

      const timeParts = parseFormattedTime(formattedDateTime);
      if (timeParts) {
        const {
          hours,
          minutes,
          seconds,
          timezone
        } = timeParts;

        // Update child elements if they exist
        const hoursElem = element.querySelector('[data-current-time-hours]');
        const minutesElem = element.querySelector('[data-current-time-minutes]');
        const secondsElem = element.querySelector('[data-current-time-seconds]');
        const timezoneElem = element.querySelector('[data-current-time-timezone]');

        if (hoursElem) hoursElem.textContent = hours;
        if (minutesElem) minutesElem.textContent = minutes;
        if (secondsElem) secondsElem.textContent = seconds;
        if (timezoneElem) timezoneElem.textContent = timezone;
      }
    });
  };

  // Initial update and interval for subsequent updates
  updateTime();
  setInterval(updateTime, 1000);
}

function initDynamicCurrentDate() {
  const defaultTimezone = "America/Mexico_City";

  const updateDate = () => {
    document.querySelectorAll('[data-current-date]').forEach((element) => {
      const timezone =
        element.getAttribute('data-current-date') || defaultTimezone;

      const formatter = new Intl.DateTimeFormat([], {
        timeZone: timezone,
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
      });

      const parts = formatter.formatToParts(new Date());

      const day = parts.find(p => p.type === 'day')?.value;
      const month = parts.find(p => p.type === 'month')?.value;
      const year = parts.find(p => p.type === 'year')?.value;

      // Actualiza SOLO si el elemento existe
      const dayElem = element.querySelector('[data-current-date-day]');
      const monthElem = element.querySelector('[data-current-date-month]');
      const yearElem = element.querySelector('[data-current-date-year]');

      if (dayElem && day) dayElem.textContent = day;
      if (monthElem && month) monthElem.textContent = month;
      if (yearElem && year) yearElem.textContent = year;
    });
  };

  updateDate();
  setInterval(updateDate, 60000); // suficiente para fecha
}

function initHorizontalScrollNarrative() {

  const ctx = gsap.context(() => {

    function wrapWords(el) {
      const text = el.textContent.trim();
      el.innerHTML = text
        .split(/\s+/)
        .map(word => `<span class="word"><span>${word}</span></span>`)
        .join(" ");
    }

    ScrollTrigger.matchMedia({

      /* =====================================
         DESKTOP + TABLET
      ===================================== */
      "(min-width: 768px)": function () {

        const stage = document.querySelector(".scroll-stage");
        const wrapper = document.querySelector(".hs-wrapper");
        const track = document.querySelector(".hs-track");
        const dsSection = wrapper.querySelector(".ds-section");

        if (!stage || !wrapper || !track || !dsSection) return;

        const texts = [...dsSection.querySelectorAll(".ds-text")];
        const nums  = [...dsSection.querySelectorAll(".ds-num")];
        const imgs  = [...dsSection.querySelectorAll(".ds-mediaimg")];

        const imgByStep = {};
        imgs.forEach(img => {
          const step = Number(img.dataset.step);
          if (!Number.isNaN(step)) imgByStep[step] = img;
        });

        texts.forEach(el => wrapWords(el));

        gsap.set(imgs, { autoAlpha: 0, scale: 0.95 });
        if (imgByStep[0]) {
          gsap.set(imgByStep[0], { autoAlpha: 1, scale: 1 });
        }

        const tl = gsap.timeline({ paused: true });

        // pausa inicial
        tl.to({}, { duration: 0.6 });

        texts.forEach((text, step) => {
          const nextText = texts[step + 1];
          if (!nextText) return;

          const currentNum = nums[step]     ?? null;
          const nextNum    = nums[step + 1] ?? null;

          const currentImg = imgByStep[step]     ?? null;
          const nextImg    = imgByStep[step + 1] ?? null;

          tl.to(text.querySelectorAll(".word span"), {
            y: "100%",
            stagger: 0.14,
            duration: 1,
            ease: "power4.in"
          });

          if (currentNum) {
            tl.to(currentNum, {
              y: "100%",
              duration: 1,
              ease: "power4.in"
            }, "<");
          }

          tl.to(nextText.querySelectorAll(".word span"), {
            y: "0%",
            stagger: 0.14,
            duration: 1,
            ease: "power4.out"
          }, "<");

          if (nextNum) {
            tl.to(nextNum, {
              y: "0%",
              duration: 1,
              ease: "power4.out"
            }, "<");
          }

          if (currentImg) {
            tl.to(currentImg, {
              autoAlpha: 0,
              scale: 0.95,
              duration: 0.6,
              ease: "power2.out",
              immediateRender: false
            }, "<");
          }

          if (nextImg) {
            tl.to(nextImg, {
              autoAlpha: 1,
              scale: 1,
              duration: 0.6,
              ease: "power2.out",
              immediateRender: false
            }, "<");
          }
        });

        // transición horizontal
        tl.to(track, {
          x: "-100vw",
          ease: "none",
          duration: 1.8
        });

        // hold final
        tl.to({}, { duration: 1 });

        ScrollTrigger.create({
          trigger: stage,
          start: "top top",
          end: "bottom bottom",
          scrub: true,
          onUpdate: self => {
            tl.progress(self.progress);
          }
        });
      }

      /* =====================================
         MOBILE
         → NO HACEMOS NADA AQUÍ
      ===================================== */

    });

  });

  return ctx;
}

function initUnicornStudio(){
  UnicornStudio.init()
    .then((scenes) => {
      // Unicorn scene is ready, you could run other code here
    })
    .catch((err) => {
      console.error(err);
    });
}

function initRevealOnScroll() {
  const revealElements = document.querySelectorAll('[data-reveal="true"]');

  revealElements.forEach(el => {
    const type = el.getAttribute('data-reveal-type') || 'y'; // default
    const duration = parseFloat(el.getAttribute('data-reveal-duration')) || 1;
    const delay = parseFloat(el.getAttribute('data-reveal-delay')) || 0;
    const ease = el.getAttribute('data-reveal-ease') || 'expo.out';
    const start = el.getAttribute('data-reveal-start') || 'top 80%';

    let animationProps = {
      opacity: 0,
      duration,
      delay,
      ease
    };

    switch (type) {
    case 'y':
      animationProps.y = 50;
      break;
    case 'scale':
      animationProps.scale = 0.2;
      break;
    case 'fade':
      // opacity only
      break;
    case 'x':
      animationProps.x = 50;
      break;
    case 'rotate':
      animationProps.rotation = 15;
      break;
    }

    gsap.from(el, {
      ...animationProps,
      scrollTrigger: {
        trigger: el,
        start,
        toggleActions: 'play none none none'
      }
    });
  });
}

function initScrambleOnHover() {
  let targets = document.querySelectorAll('[data-scramble-hover="link"]');

  targets.forEach((target) => {
    let textEl = target.querySelector('[data-scramble-hover="target"]');
    let originalText = textEl.textContent;

    let split = new SplitText(textEl, {
      type: "words, chars",
      wordsClass: "word",
      charsClass: "char"
    });

    const specialChars = "ᛝ♪✧∞✷⊛𓇼♡⟡⚚✮𖤐❃ᕯ௹↫⇝⟴❥⚤∰㊡ね⊗ㅩ";

    target.addEventListener("mouseenter", () => {
      gsap.to(textEl, {
        duration: 0.6,
        scrambleText: {
          text: originalText,
          chars: specialChars
        },
        onComplete: () => {
        }
      });
    });
  });
}

function initScrambleLoop() {
  let targets = document.querySelectorAll('[data-scramble-loop]');

  targets.forEach((target) => {
    let interval = parseInt(target.getAttribute("data-scramble-interval")) || 5000;
    let originalText = target.textContent;
    
    target.style.display = "inline-block";
    target.style.whiteSpace = "nowrap";
    
    let rect = target.getBoundingClientRect();
    
    target.style.width = `${rect.width}px`;
    
    target.style.overflow = "hidden";
    
    target.style.verticalAlign = "bottom";

    let scramble = () => {
      gsap.to(target, {
        duration: 1.5,
        scrambleText: {
          text: originalText,
          chars: "ᛝ♪✧∞✷⊛𓇼♡⟡⚚✮𖤐❃ᕯ௹↫⇝⟴❥⚤∰㊡ね⊗ㅩ",
          speed: 0.8
        }
      });
    };

    scramble();
    setInterval(scramble, interval);
  });
}

function initGlobalParallax() {
  const mm = gsap.matchMedia()

  mm.add(
    {
      isMobile: "(max-width:479px)",
      isMobileLandscape: "(max-width:767px)",
      isTablet: "(max-width:991px)",
      isDesktop: "(min-width:992px)"
    },
    (context) => {
      const { isMobile, isMobileLandscape, isTablet } = context.conditions

      const ctx = gsap.context(() => {
        document.querySelectorAll('[data-parallax="trigger"]').forEach((trigger) => {
          // Check if this trigger has to be disabled on smaller breakpoints
          const disable = trigger.getAttribute("data-parallax-disable")
          if (
            (disable === "mobile" && isMobile) ||
            (disable === "mobileLandscape" && isMobileLandscape) ||
            (disable === "tablet" && isTablet)
          ) {
            return
          }

          // Optional: you can target an element inside a trigger if necessary 
          const target = trigger.querySelector('[data-parallax="target"]') || trigger

          // Get the direction value to decide between xPercent or yPercent tween
          const direction = trigger.getAttribute("data-parallax-direction") || "vertical"
          const prop = direction === "horizontal" ? "xPercent" : "yPercent"

          // Get the scrub value, our default is 'true' because that feels nice with Lenis
          const scrubAttr = trigger.getAttribute("data-parallax-scrub")
          const scrub = scrubAttr ? parseFloat(scrubAttr) : true

          // Get the start position in % 
          const startAttr = trigger.getAttribute("data-parallax-start")
          const startVal = startAttr !== null ? parseFloat(startAttr) : 20

          // Get the end position in %
          const endAttr = trigger.getAttribute("data-parallax-end")
          const endVal = endAttr !== null ? parseFloat(endAttr) : -20

          // Get the start value of the ScrollTrigger
          const scrollStartRaw = trigger.getAttribute("data-parallax-scroll-start") ||
            "top bottom"
          const scrollStart = `clamp(${scrollStartRaw})`

          // Get the end value of the ScrollTrigger  
          const scrollEndRaw = trigger.getAttribute("data-parallax-scroll-end") ||
            "bottom top"
          const scrollEnd = `clamp(${scrollEndRaw})`

          gsap.fromTo(
            target, {
              [prop]: startVal
            },
            {
              [prop]: endVal,
              ease: "none",
              scrollTrigger: {
                trigger,
                start: scrollStart,
                end: scrollEnd,
                scrub,
              },
            }
          )
        })
      })

      return () => ctx.revert()
    }
  )
}

function initSpeedometerScroll() {
  const ctx = gsap.context(() => {
    const blocks = gsap.utils.toArray(".speed-block");
    const listLeftItems = gsap.utils.toArray(".process-list_item.is--left");
    const listRightItems = gsap.utils.toArray(".process-list_item.is--right");

    gsap.set(blocks, { fill: "none" });
    gsap.set([...listLeftItems, ...listRightItems], { autoAlpha: 0 }); // ocultar todos
    gsap.set(listLeftItems[0], { autoAlpha: 1 });
    gsap.set(listRightItems[0], { autoAlpha: 1 });

    const loops = 5;
    const totalSteps = blocks.length;
    const loopDuration = totalSteps * 0.05;

    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: ".pin-height",
        start: "top top",
        end: "bottom bottom",
        scrub: true
      }
    });

    for (let j = 0; j < loops; j++) {
      const loopStart = j * loopDuration;

      if (j > 0) {
        blocks.forEach((el, i) => {
          tl.to(el, { fill: "none", duration: 0.001 }, loopStart);
        });
      }

      // Ocultar todos los items y mostrar el correspondiente
      tl.to([...listLeftItems, ...listRightItems], { autoAlpha: 0, duration: 0.001 },
        loopStart);
      tl.to(listLeftItems[j], { autoAlpha: 1, duration: 0.3 }, loopStart);
      tl.to(listRightItems[j], { autoAlpha: 1, duration: 0.3 }, loopStart);

      // Animar cada bloque del velocímetro
      blocks.forEach((el, i) => {
        tl.to(el, {
          fill: "white",
          duration: 0.1
        }, loopStart + i * 0.05);
      });
    }
  });

  return () => ctx.revert();
}

function init3dPerspectiveHover() {
  // Skip on touch / non-hover devices
  const canHover = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
  if (!canHover) return () => {};

  // Skip if there's no targets on page
  const nodeList = document.querySelectorAll('[data-3d-hover-target]');
  if (!nodeList.length) return () => {};
  
  // Skip if user prefers reduced motion
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return () => {};

  const DEFAULT_MAX_DEG = 20;
  const EASE = 'power3.out';
  const DURATION  = 0.5;

  const targets = Array.from(nodeList).map((el) => {
    const maxAttr = parseFloat(el.getAttribute('data-max-rotate'));
    const maxRotate = Number.isFinite(maxAttr) ? maxAttr : DEFAULT_MAX_DEG;

    const setRotationX = gsap.quickSetter(el, 'rotationX', 'deg');
    const setRotationY = gsap.quickSetter(el, 'rotationY', 'deg');

    return {
      el,
      maxRotate,
      rect: el.getBoundingClientRect(),
      proxy: { rx: 0, ry: 0 },
      setRotationX,
      setRotationY,
    };
  });

  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let isFrameScheduled = false;

  function measureAll() {
    for (const target of targets) {
      target.rect = target.el.getBoundingClientRect();
    }
  }

  function onPointerMove(event) {
    mouseX = event.clientX;
    mouseY = event.clientY;
    if (!isFrameScheduled) {
      isFrameScheduled = true;
      requestAnimationFrame(updateAll);
    }
  }

  function updateAll() {
    isFrameScheduled = false;

    for (const target of targets) {
      const { rect, maxRotate, proxy, setRotationX, setRotationY } = target;

      const centerX = rect.left + rect.width  / 2;
      const centerY = rect.top  + rect.height / 2;

      const normX = Math.max(-1, Math.min(1, (mouseX - centerX) / ((rect.width  / 2) || 1)));
      const normY = Math.max(-1, Math.min(1, (mouseY - centerY) / ((rect.height / 2) || 1)));

      const rotationY = normX * maxRotate;
      const rotationX = -normY * maxRotate;

      gsap.to(proxy, {
        rx: rotationX,
        ry: rotationY,
        duration: DURATION,
        ease: EASE,
        overwrite: true,
        onUpdate: () => {
          setRotationX(proxy.rx);
          setRotationY(proxy.ry);
        }
      });
    }
  }

  // stable listener so we can remove them later
  function onResize() { requestAnimationFrame(measureAll); }
  function onScroll() { requestAnimationFrame(measureAll); }

  // init
  measureAll();
  document.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });

  // expose cleanup
  function destroy() {
    document.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onScroll);
  }

  return destroy;
}

function initHorizontalWordsScroll() {
  document.fonts.ready.then(function() {
    $('.horizontal-words').each(function () {
      const $container = $(this);
      const $wrapper = $container.find('.horizontal-words_wrapper');
      const $text = $wrapper.find('.horizontal-words_text');

      if (!$wrapper.length || !$text.length) return;

      SplitText.create($text[0], {
        type: 'chars',
        charsClass: 'letter'
      });

      const $letters = $text.find('.letter');

      gsap.set($letters, { 
        display: 'inline-block',
        force3D: true
      });

      const scrollTween = gsap.fromTo(
        $wrapper, { xPercent: 50 },
        {
          xPercent: -100,
          ease: 'none',
          scrollTrigger: {
            trigger: $container[0],
            start: '-50% top',
            end: '125% bottom',
            scrub: true
          }
        }
      );

      $letters.each(function () {
        gsap.from(this, {
          yPercent: gsap.utils.random(-200, 200),
          rotation: gsap.utils.random(-30, 30),
          opacity: 0,
          ease: 'elastic.out(1.1, 0.8)', 
          scrollTrigger: {
            trigger: this,
            containerAnimation: scrollTween,
            start: 'left 90%',
            end: 'left 10%',
            scrub: 0.2
          }
        });
      });
    });
  });
}

function init3dImageCarousel() {
  let radius;
  let draggableInstance;
  let observerInstance;
  let spin;
  let intro;
  let lastWidth = window.innerWidth;

  const wrap = document.querySelector('[data-3d-carousel-wrap]');
  if (!wrap) return;

  // Define the radius of your cylinder here
  const calcRadius = () => {
    const container = wrap.closest('.container');
    const containerWidth = container ? container.offsetWidth : window.innerWidth;
    radius = containerWidth * 0.5; // Ajusta el 0.5 al porcentaje que desees
  };

  // Destroy function to reset everything on resize
  const destroy = () => {
    draggableInstance && draggableInstance.kill();
    observerInstance && observerInstance.kill();
    spin && spin.kill();
    intro && intro.kill();
    ScrollTrigger.getAll().forEach(st => st.kill());
    const panels = wrap.querySelectorAll('[data-3d-carousel-panel]');
    gsap.set(panels, { clearProps: 'transform' });
  };

  // Create function that sets the spin, drag, and rotation
  const create = () => {
    calcRadius();

    const panels = wrap.querySelectorAll('[data-3d-carousel-panel]');
    const content = wrap.querySelectorAll('[data-3d-carousel-content]');
    const proxy = document.createElement('div');
    const wrapProgress = gsap.utils.wrap(0, 1);
    const dragDistance = window.innerWidth * 3; // Control the snapiness on drag
    let startProg;

    // Position panels in 3D space
    panels.forEach(p =>
      p.style.transformOrigin = `50% 50% ${-radius}px`
    );

    // Infinite rotation of all panels
    spin = gsap.fromTo(
      panels, { rotationY: i => (i * 360) / panels.length }, {
        rotationY: '-=360',
        duration: 30,
        ease: 'none',
        repeat: -1
      }
    );

    // cheeky workaround to create some 'buffer' when scrolling back up
    spin.progress(1000)

    draggableInstance = Draggable.create(proxy, {
      trigger: wrap,
      type: 'x',
      inertia: true,
      allowNativeTouchScrolling: true,
      onPress() {
        // Subtle feedback on touch/mousedown of the wrap
        gsap.to(content, {
          clipPath: 'inset(5%)',
          duration: 0.3,
          ease: 'power4.out',
          overwrite: 'auto'
        });
        // Stop automatic spinning to prepare for drag
        gsap.killTweensOf(spin);
        spin.timeScale(0);
        startProg = spin.progress();
      },
      onDrag() {
        const p = startProg + (this.startX - this.x) / dragDistance;
        spin.progress(wrapProgress(p));
      },
      onThrowUpdate() {
        const p = startProg + (this.startX - this.x) / dragDistance;
        spin.progress(wrapProgress(p));
      },
      onRelease() {
        if (!this.tween || !this.tween.isActive()) {
          gsap.to(spin, { timeScale: 1, duration: 0.1 });
        }
        gsap.to(content, {
          clipPath: 'inset(0%)',
          duration: 0.5,
          ease: 'power4.out',
          overwrite: 'auto'
        });
      },
      onThrowComplete() {
        gsap.to(spin, { timeScale: 1, duration: 0.1 });
      }
    })[0];

    // Scroll-into-view animation
    intro = gsap.timeline({
      scrollTrigger: {
        trigger: wrap,
        start: 'top 80%',
        end: 'bottom top',
        scrub: false,
        toggleActions: 'play resume play play'
      },
      defaults: { ease: 'expo.inOut' }
    });
    intro
      .fromTo(spin, { timeScale: 15 }, { timeScale: 1, duration: 2 })
      .fromTo(wrap, { scale: 0.5, rotation: 12 }, { scale: 1, rotation: 5, duration: 1.2 }, '<')
      .fromTo(content, { autoAlpha: 0 }, {
        autoAlpha: 1,
        stagger: {
          amount: 0.8,
          from: 'random'
        }
      }, '<');

    // While-scrolling feedback
    observerInstance = Observer.create({
      target: window,
      type: 'wheel,scroll,touch',
      onChangeY: self => {
        // Control how much scroll speed affects the rotation on scroll
        let v = gsap.utils.clamp(-60, 60, self.velocityY * 0.005);
        spin.timeScale(v);
        const resting = v < 0 ? -1 : 1;

        gsap.fromTo({ value: v }, { value: v },
        {
          value: resting,
          duration: 1.2,
          onUpdate() {
            spin.timeScale(this.targets()[0].value);
          }
        });
      }
    });

  };

  // First create on function call
  create();

  // Debounce function to use on resize events
  const debounce = (fn, ms) => {
    let t;
    return () => {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  };

  // Whenever window resizes, first destroy, then re-init it all
  window.addEventListener('resize', debounce(() => {
    const newWidth = window.innerWidth;
    if (newWidth !== lastWidth) {
      lastWidth = newWidth;
      destroy();
      create();
      ScrollTrigger.refresh();
    }
  }, 200));

}

function initLogoWallCycle() {
  const loopDelay = 0.8;
  const duration = 0.8;

  document.querySelectorAll('[data-logo-wall-cycle-init]').forEach(root => {
    const list = root.querySelector('[data-logo-wall-list]');
    const items = Array.from(list.querySelectorAll('[data-logo-wall-item]'));

    const shuffleFront = root.getAttribute('data-logo-wall-shuffle') !== 'false';
    const originalTargets = items
      .map(item => item.querySelector('[data-logo-wall-target]'))
      .filter(Boolean);

    let visibleItems = [];
    let visibleCount = 0;
    let pool = [];
    let pattern = [];
    let patternIndex = 0;
    let tl;

    function isVisible(el) {
      return window.getComputedStyle(el).display !== 'none';
    }

    function shuffleArray(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    function setup() {
      if (tl) {
        tl.kill();
      }
      visibleItems = items.filter(isVisible);
      visibleCount = visibleItems.length;

      pattern = shuffleArray(
        Array.from({ length: visibleCount }, (_, i) => i)
      );
      patternIndex = 0;

      items.forEach(item => {
        item.querySelectorAll('[data-logo-wall-target]').forEach(old => old.remove());
      });

      pool = originalTargets.map(n => n.cloneNode(true));

      let front, rest;
      if (shuffleFront) {
        const shuffledAll = shuffleArray(pool);
        front = shuffledAll.slice(0, visibleCount);
        rest = shuffleArray(shuffledAll.slice(visibleCount));
      } else {
        front = pool.slice(0, visibleCount);
        rest = shuffleArray(pool.slice(visibleCount));
      }
      pool = front.concat(rest);

      for (let i = 0; i < visibleCount; i++) {
        const parent =
          visibleItems[i].querySelector('[data-logo-wall-target-parent]') ||
          visibleItems[i];
        parent.appendChild(pool.shift());
      }

      tl = gsap.timeline({ repeat: -1, repeatDelay: loopDelay });
      tl.call(swapNext);
      tl.play();
    }

    function swapNext() {
      const nowCount = items.filter(isVisible).length;
      if (nowCount !== visibleCount) {
        setup();
        return;
      }
      if (!pool.length) return;

      const idx = pattern[patternIndex % visibleCount];
      patternIndex++;

      const container = visibleItems[idx];
      const parent =
        container.querySelector('[data-logo-wall-target-parent]') ||
        container.querySelector('*:has(> [data-logo-wall-target])') ||
        container;
      const existing = parent.querySelectorAll('[data-logo-wall-target]');
      if (existing.length > 1) return;

      const current = parent.querySelector('[data-logo-wall-target]');
      const incoming = pool.shift();

      gsap.set(incoming, {
        yPercent: 100,
        autoAlpha: 0,
        scale: 0.8,
        rotationX: 45,
        transformPerspective: 600
      });

      parent.appendChild(incoming);

      if (current) {
        gsap.to(current, {
          yPercent: -100,
          autoAlpha: 0,
          scale: 0.8,
          rotationX: -45,
          duration,
          ease: "power4.inOut",
          onComplete: () => {
            current.remove();
            pool.push(current);
          }
        });
      }

      gsap.to(incoming, {
        yPercent: 0,
        autoAlpha: 1,
        scale: 1,
        rotationX: 0,
        duration,
        delay: 0.1,
        ease: "power4.out"
      });
    }

    setup();

    ScrollTrigger.create({
      trigger: root,
      start: 'top bottom',
      end: 'bottom top',
      onEnter: () => tl.play(),
      onLeave: () => tl.pause(),
      onEnterBack: () => tl.play(),
      onLeaveBack: () => tl.pause()
    });

    document.addEventListener('visibilitychange', () =>
      document.hidden ? tl.pause() : tl.play()
    );
  });
}

function initMaskTextScrollReveal() {

  let headings = document.querySelectorAll('[data-split="heading"]');
  headings.forEach(heading => {
    SplitText.create(heading, {
      type: "lines",
      autoSplit: true,
      mask: "lines",
      onSplit(instance) {
        return gsap.from(instance.lines, {
          duration: 0.8,
          yPercent: 110,
          stagger: 0.1,
          ease: "expo.out",
          scrollTrigger: {
            trigger: heading,
            start: 'top 80%',
            once: true
          }
        });
      }
    });
  });
}

function initRollingTextScrollReveal() {
  // Seleccionamos cualquier elemento con el atributo data-split="rolling"
  const elements = document.querySelectorAll('[data-split="rolling"]');

  elements.forEach(el => {
    // 1. Dividir el texto en caracteres
    const split = new SplitText(el, { 
      type: "chars, lines", 
      charsClass: "rolling-char",
      linesClass: "rolling-line" // La línea servirá de máscara
    });

    // 2. Configuración 3D dinámica
    // Calculamos el radio de giro según el tamaño de la fuente
    const fontSize = parseFloat(window.getComputedStyle(el).fontSize);
    const depth = fontSize * 0.6; // Radio del "cilindro"
    
    // Aplicamos perspectiva al contenedor de la línea
    gsap.set(split.lines, { perspective: 500 });

    // 3. Animación con ScrollTrigger
    gsap.from(split.chars, {
      scrollTrigger: {
        trigger: el,
        start: "top 90%",
        once: true
      },
      duration: 1.2,
      opacity: 0,
      rotationX: -110, // Inclinación inicial
      z: -depth,       // Se aleja en el eje Z
      y: depth,        // Baja un poco para acentuar el giro
      transformOrigin: `50% 50% -${depth}px`, // El "eje" invisible detrás del texto
      stagger: 0.03,
      ease: "expo.out",
      clearProps: "all" // Limpia los estilos al terminar para evitar bugs de renderizado
    });
  });
}

function initFlipOnScroll() {
  function isDesktopNonTouch() {
    return window.matchMedia("(min-width: 992px)").matches && !(navigator.maxTouchPoints > 0 ||
      'ontouchstart' in window);
  }

  if (!isDesktopNonTouch()) return;

  let wrapperElements = document.querySelectorAll("[data-flip-element='wrapper']");
  let targetEl = document.querySelector("[data-flip-element='target']");
  let tl;

  function flipTimeline() {
    if (tl) {
      tl.kill();
      gsap.set(targetEl, { clearProps: "all" });
    }

    tl = gsap.timeline({
      scrollTrigger: {
        trigger: wrapperElements[0],
        start: "center center",
        endTrigger: wrapperElements[wrapperElements.length - 1],
        end: "center center",
        scrub: true
      }
    });

    wrapperElements.forEach(function (element, index) {
      let nextIndex = index + 1;
      if (nextIndex < wrapperElements.length) {
        let nextWrapperEl = wrapperElements[nextIndex];
        let nextRect = nextWrapperEl.getBoundingClientRect();
        let thisRect = element.getBoundingClientRect();
        let nextDistance = nextRect.top + window.pageYOffset + nextWrapperEl.offsetHeight / 2;
        let thisDistance = thisRect.top + window.pageYOffset + element.offsetHeight / 2;
        let offset = nextDistance - thisDistance;

        tl.add(
          Flip.fit(targetEl, nextWrapperEl, {
            duration: offset,
            ease: "none"
          })
        );
      }
    });
  }

  flipTimeline();

  let resizeTimer;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (!isDesktopNonTouch()) {
        if (tl) {
          tl.kill();
          ScrollTrigger.getAll().forEach(trigger => trigger.kill());
          gsap.set(targetEl, { clearProps: "all" });
        }
        return;
      }
      flipTimeline();
    }, 150);
  });
}

function initVimeoLightboxAdvanced() {
  // Single lightbox container
  const lightbox = document.querySelector('[data-vimeo-lightbox-init]');
  if (!lightbox) return;

  // Open & close buttons
  const openButtons = document.querySelectorAll('[data-vimeo-lightbox-control="open"]');
  const closeButtons = document.querySelectorAll('[data-vimeo-lightbox-control="close"]');

  // Core elements inside lightbox
  let iframe = lightbox.querySelector('iframe'); // ← now let
  const placeholder = lightbox.querySelector('.vimeo-lightbox__placeholder');
  const calcEl = lightbox.querySelector('.vimeo-lightbox__calc');
  const wrapEl = lightbox.querySelector('.vimeo-lightbox__calc-wrap');
  const playerContainer = lightbox.querySelector('[data-vimeo-lightbox-player]');

  // State
  let player = null;
  let currentVideoID = null;
  let videoAspectRatio = null;
  let globalMuted = lightbox.getAttribute('data-vimeo-muted') === 'true';
  const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  const playedOnce = new Set(); // track first play on touch

  // Format time (seconds → "m:ss")
  function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  // Clamp wrap height
  function clampWrapSize(ar) {
    const w = calcEl.offsetWidth;
    const h = calcEl.offsetHeight;
    wrapEl.style.maxWidth = Math.min(w, h / ar) + 'px';
  }

  // Adjust sizing in "cover" mode
  function adjustCoverSizing() {
    if (!videoAspectRatio) return;
    const cH = playerContainer.offsetHeight;
    const cW = playerContainer.offsetWidth;
    const r = cH / cW;
    const wEl = lightbox.querySelector('.vimeo-lightbox__iframe');
    if (r > videoAspectRatio) {
      wEl.style.width = (r / videoAspectRatio * 100) + '%';
      wEl.style.height = '100%';
    } else {
      wEl.style.height = (videoAspectRatio / r * 100) + '%';
      wEl.style.width = '100%';
    }
  }

  // Close & pause lightbox
  function closeLightbox() {
    lightbox.setAttribute('data-vimeo-activated', 'false');
    if (player) {
      player.pause();
      lightbox.setAttribute('data-vimeo-playing', 'false');
    }
  }

  // Wire Escape key & close buttons
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeLightbox();
  });
  closeButtons.forEach(btn => btn.addEventListener('click', closeLightbox));

  // Setup Vimeo Player event handlers
  function setupPlayerEvents() {
    // Hide placeholder when playback starts
    player.on('play', () => {
      lightbox.setAttribute('data-vimeo-loaded', 'true');
      lightbox.setAttribute('data-vimeo-playing', 'true');
    });
    // Close on video end
    player.on('ended', closeLightbox);

    // Paused
    player.on('pause', () => {
      lightbox.setAttribute('data-vimeo-playing', 'false');
    });

    // Duration UI
    const durEl = lightbox.querySelector('[data-vimeo-duration]');
    player.getDuration().then(d => {
      if (durEl) durEl.textContent = formatTime(d);
      lightbox.querySelectorAll('[data-vimeo-control="timeline"],progress')
        .forEach(el => el.max = d);
    });

    // Timeline & progress updates
    const tl = lightbox.querySelector('[data-vimeo-control="timeline"]');
    const pr = lightbox.querySelector('progress');
    player.on('timeupdate', data => {
      if (tl) tl.value = data.seconds;
      if (pr) pr.value = data.seconds;
      if (durEl) durEl.textContent = formatTime(Math.trunc(data.seconds));
    });
    if (tl) {
      ['input', 'change'].forEach(evt =>
        tl.addEventListener(evt, e => {
          const v = e.target.value;
          player.setCurrentTime(v);
          if (pr) pr.value = v;
        })
      );
    }

    // Hover → hide controls after a timeout
    let hoverTimer;
    playerContainer.addEventListener('mousemove', () => {
      lightbox.setAttribute('data-vimeo-hover', 'true');
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        lightbox.setAttribute('data-vimeo-hover', 'false');
      }, 3000);
    });

    // Fullscreen toggle on player container
    const fsBtn = lightbox.querySelector('[data-vimeo-control="fullscreen"]');
    if (fsBtn) {
      const isFS = () => document.fullscreenElement || document.webkitFullscreenElement;
      if (!(document.fullscreenEnabled || document.webkitFullscreenEnabled)) {
        fsBtn.style.display = 'none';
      }
      fsBtn.addEventListener('click', () => {
        if (isFS()) {
          lightbox.setAttribute('data-vimeo-fullscreen', 'false');
          (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        } else {
          lightbox.setAttribute('data-vimeo-fullscreen', 'true');
          (playerContainer.requestFullscreen || playerContainer.webkitRequestFullscreen)
          .call(playerContainer);
        }
      });
      ['fullscreenchange', 'webkitfullscreenchange'].forEach(evt =>
        document.addEventListener(evt, () =>
          lightbox.setAttribute('data-vimeo-fullscreen', isFS() ? 'true' : 'false')
        ));
    }
  }

  // Run sizing logic
  async function runSizing() {
    const mode = lightbox.getAttribute('data-vimeo-update-size');
    const w = await player.getVideoWidth();
    const h = await player.getVideoHeight();
    const ar = h / w;
    const bef = lightbox.querySelector('.vimeo-lightbox__before');

    if (mode === 'true') {
      if (bef) bef.style.paddingTop = (ar * 100) + '%';
      clampWrapSize(ar);
    } else if (mode === 'cover') {
      videoAspectRatio = ar;
      if (bef) bef.style.paddingTop = '0%';
      adjustCoverSizing();
    } else {
      clampWrapSize(ar);
    }
  }

  // Re-run sizing on viewport resize
  window.addEventListener('resize', () => {
    if (player) runSizing();
  });

  // Open or switch video
  async function openLightbox(id, placeholderBtn) {
    // Enter loading state immediately
    lightbox.setAttribute('data-vimeo-activated', 'loading');
    lightbox.setAttribute('data-vimeo-loaded', 'false');

    // — FULL RESET if new video ID —
    if (player && id !== currentVideoID) {
      await player.pause();
      await player.unload();

      // Replace old iframe with a fresh one
      const oldIframe = iframe;
      const newIframe = document.createElement('iframe');
      newIframe.className = oldIframe.className;
      newIframe.setAttribute('allow', oldIframe.getAttribute('allow'));
      newIframe.setAttribute('frameborder', '0');
      newIframe.setAttribute('allowfullscreen', 'true');
      newIframe.setAttribute('allow', 'autoplay; encrypted-media');
      oldIframe.parentNode.replaceChild(newIframe, oldIframe);

      // Reset state
      iframe = newIframe;
      player = null;
      currentVideoID = null;
      lightbox.setAttribute('data-vimeo-playing', 'false');
    }

    // Update placeholder image attributes
    if (placeholderBtn) {
      ['src', 'srcset', 'sizes', 'alt', 'width'].forEach(attr => {
        const val = placeholderBtn.getAttribute(attr);
        if (val != null) placeholder.setAttribute(attr, val);
      });
    }

    // Build a brand-new player if needed
    if (!player) {
      iframe.src =
        `https://player.vimeo.com/video/${id}?api=1&background=1&autoplay=0&loop=0&muted=0`;
      player = new Vimeo.Player(iframe);
      setupPlayerEvents();
      currentVideoID = id;
      await runSizing();
    }

    // Now sizing is ready — show lightbox
    lightbox.setAttribute('data-vimeo-activated', 'true');

    // Autoplay logic
    if (!isTouch) {
      player.setVolume(globalMuted ? 0 : 1).then(() => {
        lightbox.setAttribute('data-vimeo-playing', 'true');
        setTimeout(() => player.play(), 50);
      });
    } else if (playedOnce.has(currentVideoID)) {
      player.setVolume(globalMuted ? 0 : 1).then(() => {
        lightbox.setAttribute('data-vimeo-playing', 'true');
        player.play();
      });
    }
  }

  // Internal controls
  lightbox.querySelector('[data-vimeo-control="play"]').addEventListener('click', () => {
    if (isTouch) {
      if (!playedOnce.has(currentVideoID)) {
        player.setVolume(0).then(() => {
          lightbox.setAttribute('data-vimeo-playing', 'true');
          player.play();
          if (!globalMuted) {
            setTimeout(() => {
              player.setVolume(1);
              lightbox.setAttribute('data-vimeo-muted', 'false');
            }, 100);
          }
          playedOnce.add(currentVideoID);
        });
      } else {
        player.setVolume(globalMuted ? 0 : 1).then(() => {
          lightbox.setAttribute('data-vimeo-playing', 'true');
          player.play();
        });
      }
    } else {
      player.setVolume(globalMuted ? 0 : 1).then(() => {
        lightbox.setAttribute('data-vimeo-playing', 'true');
        setTimeout(() => player.play(), 50);
      });
    }
  });

  lightbox.querySelector('[data-vimeo-control="pause"]').addEventListener('click', () => {
    player.pause();
  });

  lightbox.querySelector('[data-vimeo-control="mute"]').addEventListener('click', () => {
    globalMuted = !globalMuted;
    player.setVolume(globalMuted ? 0 : 1).then(() =>
      lightbox.setAttribute('data-vimeo-muted', globalMuted ? 'true' : 'false')
    );
  });

  // Wire up open buttons
  openButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const vid = btn.getAttribute('data-vimeo-lightbox-id');
      const img = btn.querySelector('[data-vimeo-lightbox-placeholder]');
      openLightbox(vid, img);
    });
  });
}

function initCSSMarquee() {
  const pixelsPerSecond = 110;
  const marquees = document.querySelectorAll('[data-css-marquee]');

  marquees.forEach(marquee => {
    marquee.querySelectorAll('[data-css-marquee-list]').forEach(list => {
      const duplicate = list.cloneNode(true);
      marquee.appendChild(duplicate);
    });
  });

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      entry.target.querySelectorAll('[data-css-marquee-list]').forEach(list =>
        list.style.animationPlayState = entry.isIntersecting ? 'running' : 'paused'
      );
    });
  }, { threshold: 0 });

  marquees.forEach(marquee => {
    marquee.querySelectorAll('[data-css-marquee-list]').forEach(list => {
      list.style.animationDuration = (list.offsetWidth / pixelsPerSecond) + 's';
      list.style.animationPlayState = 'paused';
    });

    observer.observe(marquee);

    gsap.fromTo(
      marquee,
      {
        scale: 0.9,
        opacity: 0
      },
      {
        scale: 1,
        opacity: 1,
        duration: 1,
        ease: "power2.out",
        scrollTrigger: {
          trigger: marquee,
          start: "top 85%",
          toggleActions: "play none none none"
        }
      }
    );
  });
}

function initSplineIconAnimation() {
  gsap.matchMedia().add("(min-width: 480px)", () => {
    gsap.to(".spline-wrapper", {
      scrollTrigger: {
        trigger: ".marquee-section",
        start: "top top",
        end: "bottom bottom",
        scrub: true,
      },
      scale: 0.8,
      xPercent: -25,
      ease: "none"
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {

  const lenis = new Lenis();
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);

  ScrollTrigger.config({
    ignoreMobileResize: true
  });

  initCookieConsent();
  initMenuButton();
  initMenu();
  initBasicCustomCursor();
  initDynamicCurrentTime();
  initDynamicCurrentDate();
  initHorizontalScrollNarrative();
  initUnicornStudio();
  initRevealOnScroll();
  initScrambleOnHover();
  initScrambleLoop();
  initGlobalParallax();
  initSpeedometerScroll();
  init3dPerspectiveHover();
  initHorizontalWordsScroll();
  init3dImageCarousel();
  initLogoWallCycle();
  initMaskTextScrollReveal();
  initRollingTextScrollReveal();
  initFlipOnScroll();
  initVimeoLightboxAdvanced();
  initCSSMarquee();
  initSplineIconAnimation();
});

let resizeTimeout;
let isResizing = false;

window.addEventListener("resize", () => {
  isResizing = true;
  clearTimeout(resizeTimeout);

  resizeTimeout = setTimeout(() => {
    isResizing = false;

    // 1. Pausamos Lenis mientras recalcula
    if (typeof lenis !== "undefined") {
      lenis.stop();
    }

    // 2. Refrescamos ScrollTrigger (esto es LO MÁS IMPORTANTE)
    ScrollTrigger.refresh(true);

    // 3. Volvemos a activar Lenis
    if (typeof lenis !== "undefined") {
      lenis.start();
    }

  }, 300); // debounce → ajustable (250–400 va bien)
});
