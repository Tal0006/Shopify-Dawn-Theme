(function ($) {
  ('use strict');

  /*------------------------------------------
        = ALL ESSENTIAL FUNCTIONS
    -------------------------------------------*/

  // Toggle mobile navigation
  function toggleMobileNavigation() {
    var navbar = $('.navigation-holder');
    var openBtn = $('.mobail-menu .open-btn');
    var xbutton = $('.mobail-menu .navbar-toggler');

    openBtn.on('click', function (e) {
      e.stopImmediatePropagation();
      navbar.toggleClass('slideInn');
      xbutton.toggleClass('x-close');
      return false;
    });
  }

  toggleMobileNavigation();

  // Function for toggle class for small menu
  function toggleClassForSmallNav() {
    var windowWidth = window.innerWidth;
    var mainNav = $('#navbar > ul');

    if (windowWidth <= 991) {
      mainNav.addClass('small-nav');
    } else {
      mainNav.removeClass('small-nav');
    }
  }

  toggleClassForSmallNav();

  // Function for small menu
  function smallNavFunctionality() {
    var windowWidth = window.innerWidth;
    var mainNav = $('.navigation-holder');
    var smallNav = $('.navigation-holder > .small-nav');
    var subMenu = smallNav.find('.sub-menu');
    var megamenu = smallNav.find('.mega-menu');
    var menuItemWidthSubMenu = smallNav.find('.menu-item-has-children > a');

    if (windowWidth <= 991) {
      subMenu.hide();
      megamenu.hide();
      menuItemWidthSubMenu.on('click', function (e) {
        var $this = $(this);
        $this.siblings().slideToggle();
        e.preventDefault();
        e.stopImmediatePropagation();
        $this.toggleClass('rotate');
      });
    } else if (windowWidth > 991) {
      mainNav.find('.sub-menu').show();
      mainNav.find('.mega-menu').show();
    }
  }

  smallNavFunctionality();

  // Function for toggle class for small menu
  function toggleClassForcatagoryNav() {
    var windowWidth = window.innerWidth;
    var mainNav = $('.mini-shop-content > ul');

    if (windowWidth <= 991) {
      mainNav.addClass('mini-shop-item');
    } else {
      mainNav.removeClass('mini-shop-item');
    }
  }

  toggleClassForcatagoryNav();

  // Function for catagory menu
  function catagoryNavFunctionality() {
    var windowWidth = window.innerWidth;
    var mainNav = $('.header-shop-item');
    var catagoryNav = $('.header-shop-item > .mini-shop-item');
    var menuItemWidthSubMenu = catagoryNav.find('.menu-item-has-children > a');

    if (windowWidth <= 991) {
      menuItemWidthSubMenu.on('click', function (e) {
        var $this = $(this);
        $this.siblings().slideToggle();
        e.preventDefault();
        e.stopImmediatePropagation();
        $this.toggleClass('rotate');
      });
    } else if (windowWidth > 991) {
      mainNav.find('.sub-menu').show();
      mainNav.find('.mega-menu').show();
    }
  }

  catagoryNavFunctionality();

  $('body').on('click', function () {
    $('.navigation-holder').removeClass('slideInn');
  });
  $('.menu-close').on('click', function () {
    $('.navigation-holder').removeClass('slideInn');
  });
  $('.menu-close').on('click', function () {
    $('.open-btn').removeClass('x-close');
  });

  // toggle3
  $('#toggle3').on('click', function () {
    $('#open3').slideToggle();
    $('.caupon-wrap.s3').toggleClass('coupon-3');
  });

  /*------------------------------------------
        = HIDE PRELOADER
    -------------------------------------------*/
  function preloader() {
    if ($('.preloader').length) {
      $('.preloader')
        .delay(100)
        .fadeOut(500, function () {
          //active wow
          wow.init();
        });
    }
  }

  /*------------------------------------------
        = WOW ANIMATION SETTING
    -------------------------------------------*/
  var wow = new WOW({
    boxClass: 'wow', // default
    animateClass: 'animated', // default
    offset: 0, // default
    mobile: true, // default
    live: true, // default
  });

  /*------------------------------------------
        = BACK TO TOP BTN SETTING
    -------------------------------------------*/
  $('<a>', {href: '#', class: 'back-to-top', 'aria-label': window.themeStrings.backToTop}).append('<i class="ti-arrow-up" aria-hidden="true"></i>').appendTo('body');

  function toggleBackToTopBtn() {
    var amountScrolled = 1000;
    if ($(window).scrollTop() > amountScrolled) {
      $('a.back-to-top').fadeIn('slow');
    } else {
      $('a.back-to-top').fadeOut('slow');
    }
  }

  $('.back-to-top').on('click', function () {
    $('html,body').animate(
      {
        scrollTop: 0,
      },
      700
    );
    return false;
  });

  /*-----------------------
       cart-plus-minus-button 
     -------------------------*/
  $('.quantitys').append('<div class="dec qtybutton qtybuttons">-</div><div class="inc qtybutton qtybuttons">+</div>');
  $('.qtybuttons').on('click', function () {
    var $button = $(this);
    var oldValue = $button.parent().find('input').val();
    if ($button.text() == '+') {
      var newVal = parseFloat(oldValue) + 1;
      $('#quantity').val(newVal);
    } else {
      // Don't allow decrementing below zero
      if (oldValue > 0) {
        var newVal = parseFloat(oldValue) - 1;
        $('#quantity').val(newVal);
      } else {
        newVal = 0;
      }
    }
    $button.parent().find('input').val(newVal);
  });

  // Single gallery slider
  function productGallary() {
    if ($('.product-active').length && $('.product-thumbnil-active').length) {
      var $sync1 = $('.product-active'),
        $sync2 = $('.product-thumbnil-active'),
        flag = false,
        duration = 500;

      $sync1
        .owlCarousel({
          rtl: document.documentElement.dir === 'rtl',
          items: 1,
          margin: 0,
          nav: true,
          navText: ['<span class="sr-only">' + window.themeStrings.previousSlide + '</span><i class="ti-arrow-left" aria-hidden="true"></i>', '<span class="sr-only">' + window.themeStrings.nextSlide + '</span><i class="ti-arrow-right" aria-hidden="true"></i>'],
          dots: false,
        })
        .on('changed.owl.carousel', function (e) {
          if (!flag) {
            flag = true;
            $sync2.trigger('to.owl.carousel', [e.item.index, duration, true]);
            flag = false;
          }
        });

      $sync2
        .owlCarousel({
          margin: 10,
          items: 3,
          nav: false,
          dots: false,
          center: false,
          responsive: {
            0: {
              items: 2,
              autoWidth: false,
            },
            400: {
              items: 3,
              autoWidth: false,
            },
            500: {
              items: 3,
              center: false,
              autoWidth: false,
            },
            600: {
              items: 3,
              autoWidth: false,
            },
            1200: {
              items: 3,
              autoWidth: false,
            },
          },
        })
        .on('click', '.owl-item', function () {
          $sync1.trigger('to.owl.carousel', [$(this).index(), duration, true]);
        })
        .on('changed.owl.carousel', function (e) {
          if (!flag) {
            flag = true;
            $sync1.trigger('to.owl.carousel', [e.item.index, duration, true]);
            flag = false;
          }
        });
    }
  }

  productGallary();

  /*==========================================================================
        WHEN DOCUMENT LOADING
    ==========================================================================*/
  $(window).on('load', function () {
    preloader();

    toggleMobileNavigation();

    smallNavFunctionality();

    toggleClassForcatagoryNav();
  });

  /*==========================================================================
        WHEN WINDOW SCROLL
    ==========================================================================*/
  $(window).on('scroll', function () {
    var headerSection = $('.site-header');

    if ($(window).scrollTop() > 300) {
      headerSection.addClass('header-fixed fadeInDown animated');
    } else {
      headerSection.removeClass('header-fixed fadeInDown animated');
    }

    // fixed header remove for register page only
    if ($('.site-header').hasClass('header-for-register')) {
      $('.site-header').removeClass('header-fixed fadeInDown animated');
    }

    toggleBackToTopBtn();
  });

  /*==========================================================================
        WHEN WINDOW RESIZE
    ==========================================================================*/
  $(window).on('resize', function () {
    toggleClassForSmallNav();
    //smallNavFunctionality();
    catagoryNavFunctionality();
    clearTimeout($.data(this, 'resizeTimer'));
    $.data(
      this,
      'resizeTimer',
      setTimeout(function () {
        smallNavFunctionality();
      }, 200)
    );
  });

  /*------------------------------------------
        = Header shopping cart toggle
    -------------------------------------------*/
  if ($('.mini-cart').length) {
    var cartToggleBtn = $('.cart-toggle-btn');
    var cartContent = $('.mini-cart-content');
    var cartContent2 = $('.header-right');
    var cartCloseBtn = $('.mini-cart-close');
    var body = $('body');

    cartToggleBtn.on('click', function (e) {
      cartContent.toggleClass('mini-cart-content-toggle');
      cartContent2.toggleClass('active');
      e.stopPropagation();
    });

    cartCloseBtn.on('click', function (e) {
      cartContent.removeClass('mini-cart-content-toggle');
      cartContent2.removeClass('active');
      e.stopPropagation();
    });

    body
      .on('click', function () {
        cartContent.removeClass('mini-cart-content-toggle');
        cartContent2.removeClass('active');
      })
      .find(cartContent)
      .on('click', function (e) {
        e.stopPropagation();
      });
  }
})(window.jQuery);
