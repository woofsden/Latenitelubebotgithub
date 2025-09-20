{pkgs}: {
  deps = [
    pkgs.rPackages.cymruservices
    pkgs.qt6.qmake
    pkgs.emacsPackages.hyperdrive
    pkgs.rPackages.diffeR
    pkgs.sbclPackages.dataloader_dot_test
    pkgs.sbclPackages.safety-params
    pkgs.ironicclient
    pkgs.perl540Packages.CPANPLUS
    pkgs.haskellPackages.bson-lens
    pkgs.rPackages.SAMtool
    pkgs.rPackages.SIFT_Hsapiens_dbSNP137
  ];
}
