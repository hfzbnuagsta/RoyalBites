//Toogle class active
const navbarNav = document.querySelector('.navbar-nav');  /* memilih elemen dengan kelas "navbar-nav" yang berfungsi sebagai container untuk link navigasi utama */

// ketika hamburger menu diklik
document.querySelector('#hamburger-menu').onclick = () => {  /* memilih elemen dengan id "hamburger-menu" yang berfungsi sebagai ikon hamburger menu */
    navbarNav.classList.toggle('active');  /* menambahkan atau menghapus kelas "active" pada elemen navbarNav untuk menampilkan atau menyembunyikan menu navigasi utama */
};


// klik di luar sidebar untuk menghilangkan navbar
const hamburger = document.querySelector('#hamburger-menu');  /* memilih elemen dengan id "hamburger-menu" yang berfungsi sebagai ikon hamburger menu */
 
document.addEventListener("click", function(e){  /* menambahkan event listener untuk mendeteksi klik di seluruh dokumen */
    if(!hamburger.contains(e.target) && !navbarNav.contains(e.target)){  /* memeriksa apakah elemen yang diklik bukanlah ikon hamburger menu dan bukan juga bagian dari navbarNav */
        navbarNav.classList.remove("active");  /* jika kondisi terpenuhi, maka kelas "active" akan dihapus dari elemen navbarNav untuk menyembunyikan menu navigasi utama */
    }
});